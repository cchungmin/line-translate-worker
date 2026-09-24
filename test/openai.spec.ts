import { afterEach, describe, expect, it, vi } from 'vitest';
import { translateWithFallback } from '../src/clients/openai';
import { buildSystemPrompt } from '../src/utils';
import type { Env } from '../src/types';

const env = { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-4o-mini' } as Env;
const options = {
	systemPrompt: buildSystemPrompt(env, 'tw-jp', 'neutral'),
	userText: '下雨天半價的店真不錯',
	maxOutputTokens: 600,
	timeoutMs: 1000,
};
const translated = '雨の日半額の店はいいね';
const completion = (content: unknown, finish_reason = 'stop', refusal: string | null = null) =>
	Response.json({ choices: [{ finish_reason, message: { content, refusal } }] });

afterEach(() => vi.restoreAllMocks());

describe('OpenAI translation response contract', () => {
	it('requests a strict schema and extracts only the translated text', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completion(JSON.stringify({ translation: translated })));
		expect(await translateWithFallback(env, options)).toMatchObject({ ok: true, text: translated });
		const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
		expect(body.response_format).toEqual({
			type: 'json_schema',
			json_schema: {
				name: 'translation', strict: true,
				schema: { type: 'object', properties: { translation: { type: 'string' } }, required: ['translation'], additionalProperties: false },
			},
		});
		expect(body.store).toBe(false);
	});

	it.each([
		JSON.stringify({ sourceText: translated }),
		JSON.stringify({ translation: translated, sourceText: 'original' }),
		'```json\n{"translation":"hello"}\n```',
		'plain text', '{"translation":', 'null', '[]', '{}',
		JSON.stringify({ translation: 42 }), JSON.stringify({ translation: '  ' }), null, 42,
	])('rejects invalid content instead of forwarding it: %s', async (content) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completion(content));
		expect(await translateWithFallback(env, options)).toMatchObject({ ok: false, errorType: 'invalid_response' });
	});

	it.each(['length', 'content_filter'])('rejects a %s completion even when the JSON is parseable', async (reason) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completion(JSON.stringify({ translation: translated }), reason));
		expect(await translateWithFallback(env, options)).toMatchObject({ ok: false, errorType: 'invalid_response' });
	});

	it('rejects refusals', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completion(JSON.stringify({ translation: translated }), 'stop', 'refused'));
		expect(await translateWithFallback(env, options)).toMatchObject({ ok: false, errorType: 'invalid_response' });
	});

	it.each([null, {}, { choices: [null] }])('rejects a malformed envelope: %s', async (body) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(body));
		expect(await translateWithFallback(env, options)).toMatchObject({ ok: false, errorType: 'invalid_response' });
	});

	it('classifies invalid upstream JSON as an invalid response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not JSON'));
		expect(await translateWithFallback(env, options)).toMatchObject({ ok: false, errorType: 'invalid_response' });
	});

	it.each(['一行目\n二行目 "引用" ☔', '{"sourceText":"雨の日半額の店はいいね"}'])('preserves legitimate translated content: %s', async (text) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completion(JSON.stringify({ translation: text })));
		expect(await translateWithFallback(env, options)).toMatchObject({ ok: true, text });
	});

	it('retries a leaked sourceText wrapper once with the fallback model', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(completion(JSON.stringify({ sourceText: translated })))
			.mockResolvedValueOnce(completion(JSON.stringify({ translation: translated })));
		expect(await translateWithFallback({ ...env, OPENAI_FALLBACK_MODEL: 'gpt-4.1-mini' }, options))
			.toMatchObject({ ok: true, text: translated, model: 'gpt-4.1-mini' });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).model).toBe('gpt-4.1-mini');
	});

	it('stops after an invalid fallback response', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completion('{"sourceText":"bad"}'));
		expect(await translateWithFallback({ ...env, OPENAI_FALLBACK_MODEL: 'gpt-4.1-mini' }, options))
			.toMatchObject({ ok: false, errorType: 'invalid_response' });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});


describe('translation language validation', () => {
	it('retries the reported wrong-language response once and returns Japanese', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(completion(JSON.stringify({ translation: 'Can you translate automatically?' })))
			.mockResolvedValueOnce(completion(JSON.stringify({ translation: '自動翻訳できるようになった？' })));
		expect(await translateWithFallback({ ...env, OPENAI_FALLBACK_MODEL: 'gpt-4.1-mini' }, {
			...options, userText: '你能自動翻譯了嗎？', targetLanguage: 'ja',
		})).toMatchObject({ ok: true, text: '自動翻訳できるようになった？', model: 'gpt-4.1-mini' });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it('does not forward English when both attempts violate the requested target', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completion(JSON.stringify({ translation: 'Can you translate automatically?' })));
		expect(await translateWithFallback({ ...env, OPENAI_FALLBACK_MODEL: 'gpt-4.1-mini' }, {
			...options, userText: '你能自動翻譯了嗎？', targetLanguage: 'ja',
		})).toMatchObject({ ok: false, errorType: 'invalid_response' });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
