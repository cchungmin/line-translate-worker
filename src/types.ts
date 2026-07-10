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
	GROUP_TRANSLATION_ENABLED?: 'true' | 'false';
	DEBUG_LOG?: 'true' | 'false';
	LINE_BOT_USER_ID?: string;
	MAX_INPUT_CHARS?: string;
	MAX_OUTPUT_TOKENS?: string;
	OPENAI_TIMEOUT_MS?: string;
	MAX_WEBHOOK_BODY_BYTES?: string;
	RATE_LIMIT_PER_MIN?: string;
	IDEMPOTENCY_TTL_SECONDS?: string;
	ERROR_REPLY_ENABLED?: 'true' | 'false';
	TRANSLATION_GUARD?: DurableObjectNamespaceLike;
}

export interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException?(): void;
}

export type ExportedHandler<E = Env> = {
	fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
};

export interface DurableObjectNamespaceLike {
	idFromName(name: string): DurableObjectIdLike;
	get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface DurableObjectIdLike {}

export interface DurableObjectStubLike {
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectStateLike {
	storage: DurableObjectStorageLike;
}

export interface DurableObjectStorageLike {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
}
