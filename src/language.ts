import type { Env } from './types';
import type { Command } from './utils';

export type TranslationTarget = 'ja' | 'zh-Hant' | 'en' | 'auto';
const QUOTED_TEXT = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/gu;
const KANA_RUN = /[\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;

function withoutLinks(text: string): string {
	return text.replace(/https?:\/\/\S+/gi, '').normalize('NFC');
}

// A conservative direction hint: kana in Chinese quotations must not turn
// the surrounding Chinese sentence into Japanese. Ambiguous input stays auto.
function hasJapaneseSentence(text: string): boolean {
	const source = withoutLinks(text);
	const unquoted = source.replace(QUOTED_TEXT, '');
	const prose = unquoted.trim() ? unquoted : source;
	return /\p{Script=Hiragana}/u.test(prose) &&
		!/[這这那嗎吗麼么們们請请說说覺觉與与你您是的]/u.test(prose);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function resolveTranslationTarget(text: string, env: Env, command: Command | null): TranslationTarget {
	if (command === 'jp-en') return 'en';
	if (command === 'jp-tw') return 'zh-Hant';
	if (command === 'tw-jp' || command === 'en-jp') return 'ja';
	if (env.TRANSLATION_MODE === 'ja2zh') return 'zh-Hant';
	if (env.TRANSLATION_MODE === 'zh2ja') return 'ja';
	if (hasJapaneseSentence(text)) return 'zh-Hant';
	// Han characters are shared by both languages, so absence of kana cannot
	// identify Chinese. Keep CJK input inside the explicit Japanese/Chinese pair.
	return CJK.test(text.replace(/https?:\/\/\S+/gi, '')) ? 'auto' : 'ja';
}

export function isUnexpectedEnglishSentence(source: string, translated: string, target: TranslationTarget): boolean {
	if (target === 'en' || !CJK.test(source) || CJK.test(translated)) return false;
	// Conservative drift check, not a general language detector. Keep short names,
	// numbers, URLs and Latin text already present in the source valid.
	const words = translated.replace(/https?:\/\/\S+/gi, '').match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? [];
	return words.length >= 3 && !words.every((word) => source.toLowerCase().includes(word.toLowerCase()));
}

// Compare script characters rather than guessing a person's nationality from a name.
export function isInvalidTranslation(source: string, translated: string, target: TranslationTarget): boolean {
	if (isUnexpectedEnglishSentence(source, translated, target)) return true;
	const original = withoutLinks(source).normalize('NFC');
	const output = withoutLinks(translated).normalize('NFC');
	const chineseTarget = target === 'zh-Hant' || (target === 'auto' && hasJapaneseSentence(source));
	if (chineseTarget) {
		const quoted = original.match(QUOTED_TEXT) ?? [];
		// Permit copied Japanese names/quoted terms, but not Japanese grammar
		// or paraphrases in a translation whose target is Traditional Chinese.
		const unexpectedKana = [...output.matchAll(KANA_RUN)].some((match) => {
			const run = match[0];
			const copiedKatakana = !/\p{Script=Hiragana}/u.test(run) && original.includes(run);
			// Brands such as 食べログ and 食べチョク combine Han, hiragana
			// and katakana. Match the copied name including its Han character;
			// never exempt trailing particles/verbs (e.g. 食べログになった).
			const hanBefore = output.slice(0, match.index).match(/\p{Script=Han}$/u)?.[0];
			const copiedMixedName = Boolean(hanBefore) &&
				/^[\p{Script=Hiragana}]+[\p{Script=Katakana}ー]+$/u.test(run) &&
				original.includes(hanBefore + run);
			return !copiedKatakana && !copiedMixedName && !quoted.some((term) => term.includes(run));
		});
		if (unexpectedKana || original.trim() === output.trim()) return true;
	}
	// Names may legitimately remain in Hangul. Reject newly introduced Hangul
	// letters, while allowing a Korean name copied from the original sentence.
	const sourceHangul = new Set(original.match(/\p{Script=Hangul}/gu) ?? []);
	if ((output.match(/\p{Script=Hangul}/gu) ?? []).some((letter) => !sourceHangul.has(letter))) return true;
	// An unchanged Japanese sentence is a failed automatic translation, not a
	// successful no-op. Keep short acknowledgements and proper names exempt.
	const kana = original.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? [];
	return (target === 'auto' || target === 'zh-Hant') && ((kana.length >= 3 && /\p{Script=Hiragana}/u.test(original)) || /は\p{Script=Han}{2,}/u.test(original)) &&
		original.trim() === output.trim();
}
