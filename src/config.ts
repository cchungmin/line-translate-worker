import type { Env } from './types';

const DEFAULT_MAX_INPUT_CHARS = 1200;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;
const DEFAULT_OPENAI_TIMEOUT_MS = 8000;
const DEFAULT_RATE_LIMIT_PER_MIN = 20;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 300;

export type AppConfig = {
	maxInputChars: number;
	maxOutputTokens: number;
	openAiTimeoutMs: number;
	rateLimitPerMin: number;
	idempotencyTtlSeconds: number;
	errorReplyEnabled: boolean;
};

export function getConfig(env: Env): AppConfig {
	return {
		maxInputChars: parsePositiveInt(env.MAX_INPUT_CHARS, DEFAULT_MAX_INPUT_CHARS),
		maxOutputTokens: parsePositiveInt(env.MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
		openAiTimeoutMs: parsePositiveInt(env.OPENAI_TIMEOUT_MS, DEFAULT_OPENAI_TIMEOUT_MS),
		rateLimitPerMin: parsePositiveInt(env.RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT_PER_MIN),
		idempotencyTtlSeconds: parsePositiveInt(
			env.IDEMPOTENCY_TTL_SECONDS,
			DEFAULT_IDEMPOTENCY_TTL_SECONDS,
		),
		errorReplyEnabled: env.ERROR_REPLY_ENABLED !== 'false',
	};
}

export function validateRequiredEnv(env: Env): { ok: true } | { ok: false; missing: string[] } {
	const required: Array<keyof Env> = [
		'LINE_CHANNEL_SECRET',
		'LINE_CHANNEL_ACCESS_TOKEN',
		'OPENAI_API_KEY',
	];
	const missing = required.filter((key) => !env[key] || String(env[key]).trim() === '');
	return missing.length === 0 ? { ok: true } : { ok: false, missing: missing as string[] };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}
