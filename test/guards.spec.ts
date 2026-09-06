import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { claimTranslationSlot, TranslationGuard } from '../src/guards';
import type { DurableObjectStateLike, DurableObjectStorageLike } from '../src/types';

class MemoryStorage implements DurableObjectStorageLike {
	private readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, value);
	}
}

async function check(guard: TranslationGuard, eventId: string, rateLimitPerMinute = 1): Promise<string> {
	const response = await guard.fetch(
		new Request('https://translation-guard/check', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ eventId, rateLimitPerMinute, idempotencyTtlSeconds: 300 }),
		}),
	);
	return ((await response.json()) as { decision: string }).decision;
}

describe('TranslationGuard', () => {
	it('blocks duplicate or over-limit sequential requests', async () => {
		const state: DurableObjectStateLike = { storage: new MemoryStorage() };
		const guard = new TranslationGuard(state);

		expect(await check(guard, 'event-a')).toBe('allowed');
		expect(await check(guard, 'event-a')).toBe('duplicate');
		expect(await check(guard, 'event-b')).toBe('rate_limited');
	});

	it('deduplicates concurrent requests through the real Durable Object binding', async () => {
		const event = { webhookEventId: 'same-event', source: { groupId: crypto.randomUUID(), type: 'group' } };
		const decisions = await Promise.all(Array.from({ length: 10 }, () => claimTranslationSlot(env.TRANSLATION_GUARD, event, 20, 300)));
		expect(decisions.filter((value) => value === 'allowed')).toHaveLength(1);
		expect(decisions.filter((value) => value === 'duplicate')).toHaveLength(9);
	});

	it('limits concurrent unique events and isolates different groups', async () => {
		const groupId = crypto.randomUUID();
		const decisions = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				claimTranslationSlot(
					env.TRANSLATION_GUARD,
					{
						webhookEventId: `event-${i}`,
						source: { groupId, type: 'group' },
					},
					3,
					300,
				),
			),
		);
		expect(decisions.filter((value) => value === 'allowed')).toHaveLength(3);
		expect(decisions.filter((value) => value === 'rate_limited')).toHaveLength(7);
		expect(
			await claimTranslationSlot(
				env.TRANSLATION_GUARD,
				{
					webhookEventId: 'event-0',
					source: { groupId: crypto.randomUUID(), type: 'group' },
				},
				3,
				300,
			),
		).toBe('allowed');
	});

	it('fails closed when the Durable Object binding is unavailable', async () => {
		const decision = await claimTranslationSlot(
			undefined,
			{
				webhookEventId: 'event-a',
				source: { type: 'group', groupId: 'group-a' },
				message: { type: 'text', text: '@翻譯 你好' },
			},
			20,
			300,
		);

		expect(decision).toBe('unavailable');
	});
});
