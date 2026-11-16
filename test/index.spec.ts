import { createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

afterEach(() => vi.restoreAllMocks());

describe('LINE translator worker', () => {
	it('returns health response on GET', async () => {
		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {} as Env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('LINE translator worker is running.');
	});

	it('rejects POST with invalid LINE signature', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			headers: {
				'x-line-signature': 'invalid',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ events: [] }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				LINE_CHANNEL_SECRET: 'test-secret',
				LINE_CHANNEL_ACCESS_TOKEN: 'token',
				OPENAI_API_KEY: 'key',
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('Invalid signature');
	});

	it('rejects an oversized webhook before reading or verifying it', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			headers: {
				'content-length': '65537',
				'x-line-signature': 'invalid',
			},
			body: '{}',
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				LINE_CHANNEL_SECRET: 'test-secret',
				LINE_CHANNEL_ACCESS_TOKEN: 'token',
				OPENAI_API_KEY: 'key',
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(413);
		expect(await response.text()).toBe('Payload Too Large');
	});

	it.each([
		['debug logging is off', { DEBUG_LOG: 'false', DEBUG_TOKEN: 'secret' }, 'Bearer secret'],
		['no token is configured', { DEBUG_LOG: 'true' }, 'Bearer '],
		['the token is missing', { DEBUG_LOG: 'true', DEBUG_TOKEN: 'secret' }, undefined],
		['the token is wrong', { DEBUG_LOG: 'true', DEBUG_TOKEN: 'secret' }, 'Bearer wrong!'],
	])('hides the debug endpoint when %s', async (_name, debugEnv, authorization) => {
		const fetch = vi.spyOn(globalThis, 'fetch');
		const request = new Request('http://example.com/debug/bot-info?debug=1', {
			headers: authorization === undefined ? {} : { authorization },
		});
		const response = await worker.fetch(request, { LINE_CHANNEL_ACCESS_TOKEN: 'token', ...debugEnv } as Env, createExecutionContext());
		expect(response.status).toBe(404);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('serves bot info only with debug logging on and the matching token', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ userId: 'U1' }));
		const request = new Request('http://example.com/debug/bot-info', { headers: { authorization: 'Bearer secret' } });
		const response = await worker.fetch(
			request,
			{ LINE_CHANNEL_ACCESS_TOKEN: 'token', DEBUG_LOG: 'true', DEBUG_TOKEN: 'secret' } as Env,
			createExecutionContext(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ userId: 'U1' });
	});

	it('integration health check returns 200', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('LINE translator worker is running.');
	});
});
