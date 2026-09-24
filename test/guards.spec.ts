import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { claimTranslationSlot, claimConversationEvent, TranslationGuard } from '../src/guards';
import type { DurableObjectStateLike, DurableObjectStorageLike } from '../src/types';

class MemoryStorage implements DurableObjectStorageLike {
	private readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return structuredClone(this.values.get(key)) as T | undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, structuredClone(value));
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


describe('persisted conversation controls', () => {
	const policy = { defaultAuto: true, explicit: false };
	it('isolates modes and deduplicates controls even after a subsequent change', async () => {
		const source = { type: 'group', groupId: crypto.randomUUID() };
		const pause = { source, webhookEventId: crypto.randomUUID() };
		const claim = (event: typeof pause, control?: 'auto' | 'pause') =>
			claimConversationEvent(env.TRANSLATION_GUARD, event, 20, 300, { ...policy, control });
		expect((await claim(pause, 'pause')).mode?.auto).toBe(false);
		expect((await claim({ source, webhookEventId: crypto.randomUUID() })).decision).toBe('skipped');
		expect((await claim({ source: { type: 'group', groupId: crypto.randomUUID() }, webhookEventId: crypto.randomUUID() })).decision).toBe('allowed');
		expect((await claim({ source, webhookEventId: crypto.randomUUID() }, 'auto')).mode?.auto).toBe(true);
		expect((await claim(pause, 'pause')).decision).toBe('duplicate');
		expect((await claim({ source, webhookEventId: crypto.randomUUID() })).mode?.auto).toBe(true);
	});

	it('persists pause through reconstruction and resumes at the exact deadline', async () => {
		const storage = new MemoryStorage();
		let guard = new TranslationGuard({ storage });
		const now = 1_800_000_000_000;
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const request = async (control?: 'pause1h', explicit = false) => {
			const response = await guard.fetch(new Request('https://translation-guard/check', {
				method: 'POST', body: JSON.stringify({ eventId: crypto.randomUUID(), rateLimitPerMinute: 20,
					idempotencyTtlSeconds: 300, policy: { ...policy, control, explicit } }),
			}));
			return response.json() as Promise<{ decision: string; mode?: { auto: boolean; resumeAt?: number } }>;
		};
		try {
			expect((await request('pause1h')).mode?.resumeAt).toBe(now + 3_600_000);
			guard = new TranslationGuard({ storage });
			expect((await request()).decision).toBe('skipped');
			expect((await request(undefined, true)).decision).toBe('allowed');
			clock.mockReturnValue(now + 3_599_999);
			expect((await request()).decision).toBe('skipped');
			clock.mockReturnValue(now + 3_600_000);
			expect((await request()).mode).toEqual({ auto: true });
		} finally { clock.mockRestore(); }
	});

	it('permits pausing after the translation rate limit is exhausted', async () => {
		const source = { type: 'room', roomId: crypto.randomUUID() };
		const claim = (control?: 'pause') => claimConversationEvent(env.TRANSLATION_GUARD,
			{ source, webhookEventId: crypto.randomUUID() }, 1, 300, { ...policy, control });
		expect((await claim()).decision).toBe('allowed');
		expect((await claim()).decision).toBe('rate_limited');
		expect((await claim('pause')).mode?.auto).toBe(false);
		expect((await claim()).decision).toBe('skipped');
	});
});


it('ignores an older queued mode change even after a newer command has been processed', async () => {
	const source = { type: 'group', groupId: crypto.randomUUID() };
	const claim = (control: 'auto' | 'pause' | 'help', eventTime: number) => claimConversationEvent(env.TRANSLATION_GUARD,
		{ source, webhookEventId: crypto.randomUUID() }, 20, 300, { defaultAuto: true, explicit: false, control, eventTime });
	expect((await claim('pause', 2000)).mode?.auto).toBe(false);
	expect((await claim('auto', 1000)).decision).toBe('skipped');
	expect((await claim('help', 3000)).mode?.auto).toBe(false);
	expect((await claim('auto', 2500)).mode?.auto).toBe(true);
});
