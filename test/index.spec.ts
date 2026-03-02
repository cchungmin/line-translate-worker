import { createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

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

	it('integration health check returns 200', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('LINE translator worker is running.');
	});
});
