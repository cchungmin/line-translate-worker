import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import * as line from '../src/clients/line';
import type { LineEvent } from '../src/utils';

const testEnv: Env = {
	...env,
	LINE_CHANNEL_SECRET: 'test-secret',
	LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
	OPENAI_API_KEY: 'test-key',
	TRIGGER_MODE: 'direct',
	DEBUG_LOG: 'false',
};

function event(text = 'hello'): LineEvent {
	return {
		type: 'message',
		webhookEventId: crypto.randomUUID(),
		replyToken: crypto.randomUUID(),
		source: { type: 'user', userId: crypto.randomUUID() },
		message: { type: 'text', text },
	};
}

async function signedRequest(events: LineEvent[]): Promise<Request> {
	const body = JSON.stringify({ events });
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(testEnv.LINE_CHANNEL_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	return new Request('https://example.com/webhook', {
		method: 'POST',
		body,
		headers: { 'x-line-signature': btoa(String.fromCharCode(...new Uint8Array(signature))) },
	});
}

async function deliver(events: LineEvent[]) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(await signedRequest(events), testEnv, ctx);
	expect(response.status).toBe(200);
	await waitOnExecutionContext(ctx);
}

function mockUpstreams(failFirstReply = false) {
	let replies = 0;
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		if (String(input) === 'https://api.openai.com/v1/chat/completions') {
			return Response.json({ choices: [{ message: { content: 'こんにちは' } }] });
		}
		if (String(input) === 'https://api.line.me/v2/bot/message/reply') {
			if (failFirstReply && replies++ === 0) throw new Error('sensitive network details');
			return Response.json({});
		}
		throw new Error('Unexpected upstream');
	});
}

afterEach(() => vi.restoreAllMocks());

describe('signed translation webhook', () => {
	it('translates a direct message, replies to its token, and suppresses redelivery', async () => {
		const upstreams = mockUpstreams();
		const message = event();
		await deliver([message]);
		expect(upstreams).toHaveBeenCalledTimes(2);
		const requestBody = JSON.parse(String(upstreams.mock.calls[0][1]?.body));
		expect(requestBody.store).toBe(false);
		expect(requestBody.messages[1].content).toContain('hello');
		expect(JSON.parse(String(upstreams.mock.calls[1][1]?.body))).toEqual({
			replyToken: message.replyToken,
			messages: [{ type: 'text', text: 'こんにちは' }],
		});
		await deliver([message]);
		expect(upstreams).toHaveBeenCalledTimes(2);
	});

	it('continues with the next message after a LINE network failure', async () => {
		const upstreams = mockUpstreams(true);
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const second = event('second');
		await deliver([event(), second]);
		expect(upstreams).toHaveBeenCalledTimes(4);
		expect(JSON.parse(String(upstreams.mock.calls[3][1]?.body)).replyToken).toBe(second.replyToken);
		expect(warning).toHaveBeenCalled();
		expect(JSON.stringify(warning.mock.calls)).not.toContain('sensitive network details');
	});

	it('isolates unexpected per-event exceptions and keeps processing', async () => {
		mockUpstreams();
		const reply = vi.spyOn(line, 'replyLineMessage').mockRejectedValueOnce(new Error('sensitive unexpected details'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const second = event('second');
		await deliver([event(), second]);
		expect(reply).toHaveBeenCalledTimes(2);
		expect(reply.mock.calls[1][0]).toBe(second.replyToken);
		expect(error).toHaveBeenCalledWith(JSON.stringify({ level: 'error', message: 'event_processing_failed' }));
	});

	it('does not send untagged group messages to either upstream', async () => {
		const upstreams = mockUpstreams();
		await deliver([{ ...event(), source: { type: 'group', groupId: crypto.randomUUID() } }]);
		expect(upstreams).not.toHaveBeenCalled();
	});
});
