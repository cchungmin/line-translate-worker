import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLineBotInfo, replyLineMessage } from '../src/clients/line';

const env: Env = { LINE_CHANNEL_SECRET: 'test-secret', LINE_CHANNEL_ACCESS_TOKEN: 'test-token', OPENAI_API_KEY: 'test-key' };

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('LINE client', () => {
	it('returns network errors without leaking their contents', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('sensitive upstream details'));
		expect(await replyLineMessage('reply-token', 'hello', env)).toEqual({ ok: false, status: 0, errorType: 'network' });
	});

	it.each(['reply', 'bot-info'])('aborts a stalled %s request after five seconds and clears the timer', async (operation) => {
		vi.useFakeTimers();
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
				}),
		);
		const result = operation === 'reply' ? replyLineMessage('reply-token', 'hello', env) : fetchLineBotInfo(env);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await result).toEqual(operation === 'reply' ? { ok: false, status: 0, errorType: 'timeout' } : null);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([200, 400, 429, 500])('handles HTTP %i and clears its timer', async (status) => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));
		expect(await replyLineMessage('reply-token', 'hello', env)).toEqual(status === 200 ? { ok: true } : { ok: false, status });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('turns bot-info network and parse failures into an unavailable result', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValueOnce(new Error('network'))
			.mockResolvedValueOnce(new Response('invalid JSON'));
		expect(await fetchLineBotInfo(env)).toBeNull();
		expect(await fetchLineBotInfo(env)).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
