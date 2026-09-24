import type { Control, ConversationMode } from './controls';
import type { DurableObjectStateLike, Env } from './types';
import type { LineEvent } from './utils';

type GuardDecision = 'allowed' | 'duplicate' | 'rate_limited' | 'unavailable' | 'skipped';

export type ConversationPolicy = { defaultAuto: boolean; explicit: boolean; eventTime?: number; control?: Control };
export type GuardResult = { decision: GuardDecision; mode?: ConversationMode };

type GuardRequest = {
	policy?: ConversationPolicy;
	eventId: string;
	rateLimitPerMinute: number;
	idempotencyTtlSeconds: number;
};

type GuardState = {
	modeChangedAt?: number;
	mode?: ConversationMode;
	controlCount?: number;
	windowStartMs: number;
	windowCount: number;
	eventExpirations: Record<string, number>;
};

const GUARD_STATE_KEY = 'translation-guard-state';
const ONE_MINUTE_MS = 60_000;

export async function claimTranslationSlot(
	guardNamespace: Env['TRANSLATION_GUARD'],
	event: LineEvent,
	rateLimitPerMinute: number,
	idempotencyTtlSeconds: number,
): Promise<GuardDecision> {
	return (await claimConversationEvent(guardNamespace, event, rateLimitPerMinute, idempotencyTtlSeconds)).decision;
}

export async function claimConversationEvent(
	guardNamespace: Env['TRANSLATION_GUARD'],
	event: LineEvent,
	rateLimitPerMinute: number,
	idempotencyTtlSeconds: number,
	policy?: ConversationPolicy,
): Promise<GuardResult> {
	const partition = getGuardPartition(event);
	const eventId = event.webhookEventId?.trim();
	if (!guardNamespace || !partition || !eventId) return { decision: 'unavailable' };
	try {
		const stub = guardNamespace.get(guardNamespace.idFromName(partition));
		const response = await stub.fetch('https://translation-guard/check', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ eventId, rateLimitPerMinute, idempotencyTtlSeconds, policy } satisfies GuardRequest),
		});
		if (!response.ok) return { decision: 'unavailable' };
		const result = (await response.json()) as GuardResult;
		return isGuardDecision(result.decision) ? result : { decision: 'unavailable' };
	} catch {
		return { decision: 'unavailable' };
	}
}

export class TranslationGuard {
	constructor(private readonly state: DurableObjectStateLike) {}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'POST' || new URL(request.url).pathname !== '/check') {
			return new Response('Not Found', { status: 404 });
		}

		let input: GuardRequest;
		try {
			input = (await request.json()) as GuardRequest;
		} catch {
			return new Response('Bad Request', { status: 400 });
		}

		if (!isValidGuardRequest(input)) {
			return new Response('Bad Request', { status: 400 });
		}

		const now = Date.now();
		const windowStartMs = Math.floor(now / ONE_MINUTE_MS) * ONE_MINUTE_MS;
		const stored = await this.state.storage.get<GuardState>(GUARD_STATE_KEY);
		const guardState: GuardState = stored ?? {
			windowStartMs,
			windowCount: 0,
			eventExpirations: {},
		};

		for (const [eventKey, expiresAt] of Object.entries(guardState.eventExpirations)) {
			if (expiresAt <= now) {
				delete guardState.eventExpirations[eventKey];
			}
		}

		let mode = guardState.mode ?? { auto: input.policy?.defaultAuto ?? true };
		if (mode.resumeAt !== undefined && mode.resumeAt <= now) mode = { auto: true };
		const eventKey = encodeURIComponent(input.eventId);
		if (guardState.eventExpirations[eventKey]) {
			return jsonDecision('duplicate');
		}

		if (guardState.windowStartMs !== windowStartMs) {
			guardState.windowStartMs = windowStartMs;
			guardState.windowCount = 0;
			guardState.controlCount = 0;
		}
		const control = input.policy?.control;
		if (!control && input.policy && !input.policy.explicit && !mode.auto) return jsonDecision('skipped');
		if ((input.policy?.control ? guardState.controlCount ?? 0 : guardState.windowCount) >= input.rateLimitPerMinute) {
			return jsonDecision('rate_limited');
		}

		if (control && control !== 'help' && input.policy?.eventTime !== undefined) {
			if (input.policy.eventTime < (guardState.modeChangedAt ?? 0)) return jsonDecision('skipped');
			guardState.modeChangedAt = input.policy.eventTime;
		}
		if (control === 'auto') mode = { auto: true };
		if (control === 'pause') mode = { auto: false };
		if (control === 'pause1h') mode = { auto: false, resumeAt: now + 3_600_000 };
		// One write commits the setting, rate counters and event ID together.
		if (input.policy) guardState.mode = mode;
		guardState.eventExpirations[eventKey] = now + input.idempotencyTtlSeconds * 1000;
		if (control) guardState.controlCount = (guardState.controlCount ?? 0) + 1;
		else guardState.windowCount += 1;
		await this.state.storage.put(GUARD_STATE_KEY, guardState);
		return jsonDecision('allowed', mode);
	}
}

function getGuardPartition(event: LineEvent): string | null {
	if (event.source?.groupId) {
		return `group:${event.source.groupId}`;
	}
	if (event.source?.roomId) {
		return `room:${event.source.roomId}`;
	}
	if (event.source?.userId) {
		return `user:${event.source.userId}`;
	}
	return null;
}

function jsonDecision(decision: Exclude<GuardDecision, 'unavailable'>, mode?: ConversationMode): Response {
	return new Response(JSON.stringify({ decision, mode }), {
		headers: { 'Content-Type': 'application/json' },
	});
}

function isGuardDecision(value: unknown): value is GuardDecision {
	return value === 'allowed' || value === 'duplicate' || value === 'rate_limited' || value === 'skipped';
}

function isValidGuardRequest(value: GuardRequest): boolean {
	return (
		(value?.policy === undefined || (
			(value.policy?.eventTime === undefined || (Number.isFinite(value.policy.eventTime) && value.policy.eventTime >= 0)) &&
			typeof value.policy?.defaultAuto === 'boolean' && typeof value.policy.explicit === 'boolean' &&
			(value.policy.control === undefined || ['auto', 'pause', 'pause1h', 'help'].includes(value.policy.control))
		)) &&
		typeof value?.eventId === 'string' &&
		value.eventId.length > 0 &&
		value.eventId.length <= 256 &&
		Number.isInteger(value.rateLimitPerMinute) &&
		value.rateLimitPerMinute > 0 &&
		Number.isInteger(value.idempotencyTtlSeconds) &&
		value.idempotencyTtlSeconds > 0
	);
}
