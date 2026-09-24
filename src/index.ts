import { parseChatCommand, hasTranslatableText, modeHelp } from './controls';
import { replyLineMessage, fetchLineBotInfo } from './clients/line';
import { translateWithFallback } from './clients/openai';
import { getConfig, validateRequiredEnv } from './config';
import { claimConversationEvent } from './guards';
import { log } from './logger';
import type { Env, ExecutionContext, ExportedHandler } from './types';
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
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

		ctx.waitUntil(handleLineEvents(payload.events ?? [], env, config));

		log(env, 'info', 'webhook_accepted', { durationMs: Date.now() - requestStart });
		return new Response('OK');
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

async function handleLineEvents(events: LineEvent[], env: Env, config: RuntimeConfig): Promise<void> {
	for (const event of events) {
		try {
			await handleLineEvent(event, env, config);
		} catch {
			// Do not include exception text: upstream errors can contain sensitive data.
			log(env, 'error', 'event_processing_failed');
		}
	}
}

async function handleLineEvent(event: LineEvent, env: Env, config: RuntimeConfig): Promise<void> {
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

	const claim = await claimConversationEvent(
		env.TRANSLATION_GUARD,
		event,
		config.rateLimitPerMin,
		config.idempotencyTtlSeconds,
		{
			defaultAuto: shouldTranslateEvent({ ...event, message: { type: 'text', text: '' } }, env),
			explicit: singleText !== undefined || hasExplicitTrigger(event, env),
			control,
		},
	);
	const slot = claim.decision;
	if (slot === 'skipped') return;
	if (slot === 'unavailable') {
		log(env, 'error', 'translation_guard_unavailable', {
			webhookEventId: event.webhookEventId ?? '',
		});
		return;
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
		await maybeReplyError(event.replyToken, '請稍後再試，訊息太頻繁。\n送信が多すぎます。少し待ってからお試しください。', env, config);
		return;
	}

	if (control) {
		if (claim.mode && event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
			const reply = await replyLineMessage(event.replyToken, modeHelp(claim.mode, welcome), env, true);
			if (!reply.ok) log(env, 'warn', 'line_control_reply_failed', { status: reply.status });
		}
		return;
	}

	if (normalized.text.length > config.maxInputChars) {
		await maybeReplyError(
			event.replyToken,
			`訊息太長，請控制在 ${config.maxInputChars} 字內再試。\n${config.maxInputChars} 文字以内で送信してください。`,
			env,
			config,
		);
		return;
	}

	const result = await translateWithFallback(env, {
		systemPrompt: buildSystemPrompt(singleText !== undefined ? { ...env, TRANSLATION_MODE: 'auto' } : env, normalized.command, normalized.styleOverride),
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
		await maybeReplyError(event.replyToken, mapOpenAiError(result.errorType), env, config);
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
