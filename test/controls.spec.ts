import { describe, expect, it } from 'vitest';
import { hasTranslatableText, parseChatCommand } from '../src/controls';

describe('shared chat controls', () => {
	it.each(['/auto later', '/pause 2h', 'please /pause', 'auto', 'pause', '/autonomous', '/together'])('does not interpret conversational text as a control: %s', (text) => {
		expect(parseChatCommand(text)).toBeNull();
	});
	it('accepts casing and whitespace from either keyboard and preserves multiline source', () => {
		expect(parseChatCommand('　/PAUSE　1h　')).toEqual({ control: 'pause1h' });
		expect(parseChatCommand('/t 你好\nこんにちは')).toEqual({ text: '你好\nこんにちは' });
		expect(parseChatCommand('/t')).toEqual({ control: 'help' });
	});
	it.each(['👍🏽', 'https://example.com/日本語', 'https://a.test https://b.test', '！？', ''])('skips nonlinguistic chatter: %s', (text) => {
		expect(hasTranslatableText(text)).toBe(false);
	});
	it.each(['好', '不要', '可以', 'はい', '123', '這個 https://example.com'])('keeps meaningful short messages: %s', (text) => {
		expect(hasTranslatableText(text)).toBe(true);
	});
});
