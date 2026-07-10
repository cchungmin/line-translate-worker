import { describe, expect, it } from 'vitest';
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
	it('atomically claims one event and blocks duplicate or over-limit requests', async () => {
		const state: DurableObjectStateLike = { storage: new MemoryStorage() };
		const guard = new TranslationGuard(state);

		expect(await check(guard, 'event-a')).toBe('allowed');
		expect(await check(guard, 'event-a')).toBe('duplicate');
		expect(await check(guard, 'event-b')).toBe('rate_limited');
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
