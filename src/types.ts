export interface Env {
	LINE_CHANNEL_SECRET: string;
	LINE_CHANNEL_ACCESS_TOKEN: string;
	OPENAI_API_KEY: string;
	OPENAI_MODEL?: string;
	OPENAI_FALLBACK_MODEL?: string;
	TRANSLATION_MODE?: 'auto' | 'ja2zh' | 'zh2ja';
	TRANSLATION_STYLE?: 'business' | 'casual' | 'neutral' | 'polite';
	TRIGGER_MODE?: 'all' | 'mention' | 'direct';
	TRIGGER_MENTION?: string;
	DEBUG_LOG?: 'true' | 'false';
	LINE_BOT_USER_ID?: string;
	MAX_INPUT_CHARS?: string;
	MAX_OUTPUT_TOKENS?: string;
	OPENAI_TIMEOUT_MS?: string;
	RATE_LIMIT_PER_MIN?: string;
	IDEMPOTENCY_TTL_SECONDS?: string;
	ERROR_REPLY_ENABLED?: 'true' | 'false';
	APP_KV?: KVNamespaceLike;
}

export interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException?(): void;
}

export type ExportedHandler<E = Env> = {
	fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
};

export interface KVNamespaceLike {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string,
		options?: {
			expiration?: number;
			expirationTtl?: number;
		},
	): Promise<void>;
}
