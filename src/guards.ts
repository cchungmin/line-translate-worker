import type { DurableObjectStateLike, Env } from './types';
import type { LineEvent } from './utils';

type GuardDecision = 'allowed' | 'duplicate' | 'rate_limited' | 'unavailable';

type GuardRequest = {
	eventId: string;
	rateLimitPerMinute: number;
	idempotencyTtlSeconds: number;
};

type GuardState = {
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
	const partition = getGuardPartition(event);
	const eventId = event.webhookEventId?.trim();
	if (!guardNamespace || !partition || !eventId) {
		return 'unavailable';
	}

	try {
		const stub = guardNamespace.get(guardNamespace.idFromName(partition));
		const response = await stub.fetch('https://translation-guard/check', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ eventId, rateLimitPerMinute, idempotencyTtlSeconds } satisfies GuardRequest),
		});
		if (!response.ok) {
			return 'unavailable';
		}

		const result = (await response.json()) as { decision?: GuardDecision };
		return isGuardDecision(result.decision) ? result.decision : 'unavailable';
	} catch {
		return 'unavailable';
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

		const eventKey = encodeURIComponent(input.eventId);
		if (guardState.eventExpirations[eventKey]) {
			return jsonDecision('duplicate');
		}

		if (guardState.windowStartMs !== windowStartMs) {
			guardState.windowStartMs = windowStartMs;
			guardState.windowCount = 0;
		}
		if (guardState.windowCount >= input.rateLimitPerMinute) {
			return jsonDecision('rate_limited');
		}

		guardState.eventExpirations[eventKey] = now + input.idempotencyTtlSeconds * 1000;
		guardState.windowCount += 1;
		await this.state.storage.put(GUARD_STATE_KEY, guardState);
		return jsonDecision('allowed');
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

function jsonDecision(decision: Exclude<GuardDecision, 'unavailable'>): Response {
	return new Response(JSON.stringify({ decision }), {
		headers: { 'Content-Type': 'application/json' },
	});
}

function isGuardDecision(value: unknown): value is GuardDecision {
	return value === 'allowed' || value === 'duplicate' || value === 'rate_limited';
}

function isValidGuardRequest(value: GuardRequest): boolean {
	return (
		typeof value?.eventId === 'string' &&
		value.eventId.length > 0 &&
		value.eventId.length <= 256 &&
		Number.isInteger(value.rateLimitPerMinute) &&
		value.rateLimitPerMinute > 0 &&
		Number.isInteger(value.idempotencyTtlSeconds) &&
		value.idempotencyTtlSeconds > 0
	);
}
