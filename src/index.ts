import { resolveTranslationTarget } from './language';
import { parseChatCommand, hasTranslatableText, modeHelp } from './controls';
import { replyLineMessage, fetchLineBotInfo } from './clients/line';
import { translateWithFallback } from './clients/openai';
import { getConfig, validateRequiredEnv } from './config';
import { claimConversationEvent } from './guards';
import { log } from './logger';
import type { Env, ExecutionContext, ExportedHandler, QueueBatch } from './types';
import {
	buildSystemPrompt,
	isValidLineSignature,
	normalizeUserText,
	readRequestBodyWithinLimit,
	shouldTranslateEvent,
	hasExplicitTrigger,
	type LineEvent,
	type LineWebhookPayload,
} from './utils';

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const requestStart = Date.now();
		const config = getConfig(env);

		if (request.method === 'GET') {
			return handleGetRequest(request, env);
		}

		const validation = validateRequiredEnv(env);
		if (!validation.ok) {
			log(env, 'error', 'missing_required_env', { missing: validation.missing });
			return new Response('Server Misconfigured', { status: 500 });
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		const rawBody = await readRequestBodyWithinLimit(request, config.maxWebhookBodyBytes);
		if (!rawBody) {
			return new Response('Payload Too Large', { status: 413 });
		}
		const signature = request.headers.get('x-line-signature') ?? '';
		if (!(await isValidLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET))) {
			return new Response('Invalid signature', { status: 401 });
		}

		let payload: LineWebhookPayload;
		try {
			payload = JSON.parse(new TextDecoder().decode(rawBody)) as LineWebhookPayload;
		} catch {
			return new Response('Bad Request', { status: 400 });
		}

		if (!Array.isArray(payload?.events)) return new Response('Bad Request', { status: 400 });
		const events = payload.events.filter((event) => event && (event.type === 'join' || event.type === 'follow' ||
			(event.type === 'message' && event.message?.type === 'text')));
		if (events.length) {
			if (!env.LINE_EVENT_QUEUE) return new Response('Queue Unavailable', { status: 503 });
			try {
				// Acknowledge LINE only after the complete batch is durably accepted.
				await env.LINE_EVENT_QUEUE.send({ version: 1, receivedAt: requestStart, events });
			} catch {
				log(env, 'error', 'webhook_enqueue_failed');
				return new Response('Queue Unavailable', { status: 503 });
			}
		}

		log(env, 'info', 'webhook_accepted', { durationMs: Date.now() - requestStart });
		return new Response('OK');
	},
	async queue(batch: QueueBatch, env: Env): Promise<void> {
		const config = getConfig(env);
		for (const message of batch.messages) {
			const job = message.body;
			if (job?.version !== 1 || !Number.isFinite(job.receivedAt) || !Array.isArray(job.events)) {
				log(env, 'error', 'invalid_queue_job');
				message.ack();
				continue;
			}
			try {
				await handleLineEvents(job.events, env, config, job.receivedAt);
				message.ack();
			} catch {
				if (message.attempts >= 4 || Date.now() >= job.receivedAt + 55_000) {
					log(env, 'error', 'queue_retry_exhausted');
					message.ack();
				} else {
					message.retry({ delaySeconds: 1 });
				}
			}
		}
	},
} satisfies ExportedHandler<Env>;

async function handleGetRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname !== '/debug/bot-info') {
		return new Response('LINE translator worker is running.');
	}
	if (env.DEBUG_LOG !== 'true' || url.searchParams.get('debug') !== '1') {
		return new Response('Not Found', { status: 404 });
	}

	const info = await fetchLineBotInfo(env);
	if (!info) {
		return new Response('Failed to fetch bot info', { status: 502 });
	}

	log(env, 'info', 'bot_info', { userId: info.userId ?? '' });
	return new Response(JSON.stringify(info), {
		headers: { 'Content-Type': 'application/json' },
	});
}

type RuntimeConfig = ReturnType<typeof getConfig>;

class RetryableEventError extends Error {}

async function handleLineEvents(events: LineEvent[], env: Env, config: RuntimeConfig, receivedAt: number): Promise<void> {
	for (const event of events) {
		try {
			await handleLineEvent(event, env, config, receivedAt);
		} catch (error) {
			if (error instanceof RetryableEventError) throw error;
			// Do not include exception text: upstream errors can contain sensitive data.
			log(env, 'error', 'event_processing_failed');
		}
	}
}

async function handleLineEvent(event: LineEvent, env: Env, config: RuntimeConfig, receivedAt: number): Promise<void> {
	const replyDeadline = receivedAt + 55_000;
	if (Date.now() >= replyDeadline) {
		log(env, 'warn', 'event_expired_before_processing', { webhookEventId: event.webhookEventId ?? '' });
		return;
	}
	const welcome = event.type === 'join' || event.type === 'follow';
	if (!welcome && (event.type !== 'message' || event.message?.type !== 'text')) {
		return;
	}

	log(env, 'info', 'event_received', {
		webhookEventId: event.webhookEventId ?? '',
		sourceType: event.source?.type ?? '',
	});

	const command = welcome ? { control: 'help' as const } : parseChatCommand(event.message?.text ?? '');
	const control = command && 'control' in command ? command.control : undefined;
	const singleText = command && 'text' in command ? command.text : undefined;
	const normalized = singleText !== undefined
		? { text: singleText, command: null, styleOverride: null }
		: normalizeUserText(event, env);
	log(env, 'info', 'event_normalized', {
		command: normalized.command ?? '',
		styleOverride: normalized.styleOverride ?? '',
		inputLength: normalized.text.length,
	});

	if (!control && (!normalized.text || !hasTranslatableText(normalized.text))) {
		return;
	}

	const explicit = singleText !== undefined || hasExplicitTrigger(event, env);
	const group = event.source?.type === 'group' || event.source?.type === 'room';
	const replyConfig = { ...config, errorReplyEnabled: config.errorReplyEnabled && (!group || explicit || Boolean(control)) };
	if (!control && !explicit && env.AUTO_TRANSLATION_ENABLED === 'false') return;
	// Reject oversize input before reserving a translation slot. Automatic chatter
	// is silent, including paused conversations, and never reaches the model.
	if (!control && normalized.text.length > config.maxInputChars) {
		log(env, 'warn', 'event_input_too_long', { inputLength: normalized.text.length });
		if (explicit) await maybeReplyError(event.replyToken,
			`訊息太長，請控制在 ${config.maxInputChars} 字內再試。\n${config.maxInputChars} 文字以内で送信してください。`, env, replyConfig);
		return;
	}

	const claim = await claimConversationEvent(
		env.TRANSLATION_GUARD,
		event,
		config.rateLimitPerMin,
		config.idempotencyTtlSeconds,
		{
			defaultAuto: shouldTranslateEvent({ ...event, message: { type: 'text', text: '' } }, env),
			explicit,
			eventTime: event.timestamp ?? receivedAt,
			control,
		},
	);
	const slot = claim.decision;
	if (slot === 'skipped') return;
	if (slot === 'unavailable') {
		log(env, 'error', 'translation_guard_unavailable', {
			webhookEventId: event.webhookEventId ?? '',
		});
		throw new RetryableEventError();
	}
	if (slot === 'duplicate') {
		log(env, 'warn', 'event_skipped_duplicate', { webhookEventId: event.webhookEventId ?? '' });
		return;
	}
	if (slot === 'rate_limited') {
		log(env, 'warn', 'event_skipped_rate_limited', {
			sourceType: event.source?.type ?? '',
			webhookEventId: event.webhookEventId ?? '',
		});
		await maybeReplyError(event.replyToken, '請稍後再試，訊息太頻繁。\n送信が多すぎます。少し待ってからお試しください。', env, replyConfig);
		return;
	}

	if (Date.now() >= replyDeadline) {
		log(env, 'warn', 'event_expired_after_admission');
		return;
	}
	if (control) {
		if (claim.mode && event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
			const disabled = env.AUTO_TRANSLATION_ENABLED === 'false';
			const notice = disabled
				? '系統已暫停自動翻譯；設定保留，仍可用 /t。\nシステム全体で自動翻訳停止中。設定は保存され、/t は利用できます。\n'
				: '';
			const text = notice + modeHelp(disabled ? { auto: false } : claim.mode, welcome);
			const reply = await replyLineMessage(event.replyToken, text, env, true);
			if (!reply.ok) log(env, 'warn', 'line_control_reply_failed', { status: reply.status });
		}
		return;
	}

	const directionEnv = singleText !== undefined ? { ...env, TRANSLATION_MODE: 'auto' as const } : env;
	const targetLanguage = resolveTranslationTarget(normalized.text, directionEnv, normalized.command);
	const result = await translateWithFallback(env, {
		targetLanguage,
		deadlineMs: replyDeadline - 5000,
		systemPrompt: buildSystemPrompt(directionEnv, normalized.command, normalized.styleOverride, targetLanguage),
		userText: normalized.text,
		maxOutputTokens: config.maxOutputTokens,
		timeoutMs: config.openAiTimeoutMs,
	});

	if (!result.ok) {
		log(env, 'warn', 'openai_failed', {
			errorType: result.errorType,
			status: result.status ?? 0,
			model: result.model,
			durationMs: result.durationMs,
		});
		await maybeReplyError(event.replyToken, mapOpenAiError(result.errorType), env, replyConfig);
		return;
	}

	if (!explicit && result.text.normalize('NFC').trim() === normalized.text.normalize('NFC').trim()) {
		log(env, 'info', 'event_skipped_unchanged_translation');
		return;
	}
	if (Date.now() >= replyDeadline) {
		log(env, 'warn', 'event_expired_before_reply');
		return;
	}

	log(env, 'info', 'openai_success', {
		model: result.model,
		durationMs: result.durationMs,
	});

	if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
		const reply = await replyLineMessage(event.replyToken, result.text, env);
		if (!reply.ok) {
			log(env, 'warn', 'line_reply_failed', {
				status: reply.status,
				errorType: reply.errorType ?? 'http',
			});
		}
	}
}

function mapOpenAiError(errorType: 'timeout' | 'quota' | 'upstream' | 'network' | 'invalid_response'): string {
	if (errorType === 'quota') {
		return '翻譯服務目前額度不足，請稍後再試。\n翻訳サービスの利用上限に達しました。しばらくしてからお試しください。';
	}
	if (errorType === 'timeout') {
		return '翻譯服務回應逾時，請稍後再試。\n翻訳がタイムアウトしました。もう一度お試しください。';
	}
	return '翻譯服務暫時忙碌，請稍後再試。\n翻訳サービスが混み合っています。しばらくしてからお試しください。';
}

async function maybeReplyError(
	replyToken: string | undefined,
	message: string,
	env: Env,
	config: RuntimeConfig,
): Promise<void> {
	if (!config.errorReplyEnabled) {
		return;
	}
	if (!replyToken || replyToken === '00000000000000000000000000000000') {
		return;
	}

	const reply = await replyLineMessage(replyToken, message, env);
	if (!reply.ok) {
		log(env, 'warn', 'line_reply_error_message_failed', {
			status: reply.status,
			errorType: reply.errorType ?? 'http',
		});
	}
}

export { TranslationGuard } from './guards';
