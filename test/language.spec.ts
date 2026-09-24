import { describe, expect, it } from 'vitest';
import { resolveTranslationTarget, isUnexpectedEnglishSentence } from '../src/language';
import { normalizeUserText, buildSystemPrompt } from '../src/utils';
import type { Env } from '../src/types';

const env = { TRANSLATION_MODE: 'auto', TRIGGER_MODE: 'direct' } as Env;

describe('translation language routing', () => {
	it.each(['你能自動翻譯了嗎？', '好', '明天見', '自動翻訳', 'Can you translate?', '看這個 https://example.com/かな'])('defaults to Japanese: %s', (text) => {
		expect(resolveTranslationTarget(text, env, null)).toBe('ja');
	});
	it.each(['自動翻訳できるようになった？', '「ありがとう」是什麼意思？'])('keeps kana/mixed text inside the Japanese/Chinese pair: %s', (text) => {
		expect(resolveTranslationTarget(text, env, null)).toBe('auto');
		expect(buildSystemPrompt(env, null, null, 'auto')).toContain('不可翻成英文');
	});
	it('prioritizes explicit tags over the deployment direction', () => {
		expect(resolveTranslationTarget('你好', env, 'jp-en')).toBe('en');
		expect(resolveTranslationTarget('你好', { ...env, TRANSLATION_MODE: 'ja2zh' }, 'tw-jp')).toBe('ja');
		expect(resolveTranslationTarget('你好', { ...env, TRANSLATION_MODE: 'ja2zh' }, null)).toBe('zh-Hant');
	});
	it('does not interpret quoted language tags as commands', () => {
		const text = '說明文件提到 @JPEN 這個指令';
		expect(normalizeUserText({ message: { type: 'text', text } }, env)).toMatchObject({ text, command: null });
		expect(normalizeUserText({ message: { type: 'text', text: '　@TWJP-N 明天見' } }, env)).toMatchObject({ text: '明天見', command: 'tw-jp', styleOverride: 'neutral' });
	});
	it('rejects the reported English sentence without rejecting explicit English translation', () => {
		const source = '你能自動翻譯了嗎？';
		const english = 'Can you translate automatically?';
		expect(isUnexpectedEnglishSentence(source, english, 'ja')).toBe(true);
		expect(isUnexpectedEnglishSentence(source, english, 'auto')).toBe(true);
		expect(isUnexpectedEnglishSentence(source, english, 'en')).toBe(false);
		expect(isUnexpectedEnglishSentence(source, '自動翻訳できるようになった？', 'ja')).toBe(false);
	});
	it.each(['OK', 'Apple Inc.', '2026', 'https://example.com/a/b/c'])('preserves short names, numbers and links: %s', (text) => {
		expect(isUnexpectedEnglishSentence('請保留名稱', text, 'ja')).toBe(false);
	});
	it('preserves Latin text already in the source', () => {
		expect(isUnexpectedEnglishSentence('名稱是 New York Times', 'New York Times', 'ja')).toBe(false);
	});
});
