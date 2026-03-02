import type { Env } from '../types';
import { DEFAULT_MODEL, formatTranslationInput } from '../utils';

type OpenAiResult =
	| { ok: true; text: string; model: string; durationMs: number }
	| {
			ok: false;
			errorType: 'timeout' | 'quota' | 'upstream' | 'network' | 'invalid_response';
			model: string;
			status?: number;
			durationMs: number;
			details?: string;
	  };

type OpenAiOptions = {
	systemPrompt: string;
	userText: string;
	maxOutputTokens: number;
	timeoutMs: number;
};

export async function translateWithFallback(env: Env, options: OpenAiOptions): Promise<OpenAiResult> {
	const primaryModel = env.OPENAI_MODEL ?? DEFAULT_MODEL;
	const firstAttempt = await requestTranslation(env, {
		...options,
		model: primaryModel,
	});

	if (firstAttempt.ok) {
		return firstAttempt;
	}

	const fallbackModel = env.OPENAI_FALLBACK_MODEL?.trim();
	if (!fallbackModel || fallbackModel === primaryModel) {
		return firstAttempt;
	}

	if (!isRetryable(firstAttempt)) {
		return firstAttempt;
	}

	return requestTranslation(env, {
		...options,
		model: fallbackModel,
	});
}

type RequestOptions = OpenAiOptions & {
	model: string;
};

async function requestTranslation(env: Env, options: RequestOptions): Promise<OpenAiResult> {
	const startedAt = Date.now();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

	try {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify({
				model: options.model,
				messages: [
					{ role: 'system', content: options.systemPrompt },
					{ role: 'user', content: formatTranslationInput(options.userText) },
				],
				temperature: 0,
				max_tokens: options.maxOutputTokens,
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			const bodyText = await response.text();
			const durationMs = Date.now() - startedAt;
			if (response.status === 429 && bodyText.includes('insufficient_quota')) {
				return {
					ok: false,
					errorType: 'quota',
					model: options.model,
					status: response.status,
					durationMs,
					details: bodyText,
				};
			}
			return {
				ok: false,
				errorType: 'upstream',
				model: options.model,
				status: response.status,
				durationMs,
				details: bodyText,
			};
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const text = data.choices?.[0]?.message?.content?.trim();
		if (!text) {
			return {
				ok: false,
				errorType: 'invalid_response',
				model: options.model,
				durationMs: Date.now() - startedAt,
			};
		}

		return {
			ok: true,
			text,
			model: options.model,
			durationMs: Date.now() - startedAt,
		};
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		const message = error instanceof Error ? error.message : String(error);
		if (message.toLowerCase().includes('abort')) {
			return { ok: false, errorType: 'timeout', model: options.model, durationMs, details: message };
		}
		return { ok: false, errorType: 'network', model: options.model, durationMs, details: message };
	} finally {
		clearTimeout(timeoutId);
	}
}

function isRetryable(result: OpenAiResult): boolean {
	if (result.ok) {
		return false;
	}
	return result.errorType === 'timeout' || result.errorType === 'network' || result.errorType === 'upstream';
}
