import type { KVNamespaceLike } from './types';
import type { LineEvent } from './utils';

export async function isDuplicateEvent(
	kv: KVNamespaceLike | undefined,
	eventId: string | undefined,
	ttlSeconds: number,
): Promise<boolean> {
	if (!kv || !eventId) {
		return false;
	}

	const key = `dedupe:${eventId}`;
	const existing = await kv.get(key);
	if (existing) {
		return true;
	}
	await kv.put(key, '1', { expirationTtl: ttlSeconds });
	return false;
}

export async function isRateLimited(
	kv: KVNamespaceLike | undefined,
	event: LineEvent,
	limitPerMinute: number,
): Promise<boolean> {
	if (!kv) {
		return false;
	}

	const sourceId =
		event.source?.userId ??
		event.source?.groupId ??
		event.source?.roomId;

	if (!sourceId) {
		return false;
	}

	const bucket = Math.floor(Date.now() / 60000);
	const key = `rate:${sourceId}:${bucket}`;
	const current = Number.parseInt((await kv.get(key)) ?? '0', 10) || 0;
	if (current >= limitPerMinute) {
		return true;
	}

	await kv.put(key, String(current + 1), { expirationTtl: 120 });
	return false;
}
