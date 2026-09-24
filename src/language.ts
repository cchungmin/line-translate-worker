import type { Env } from './types';
import type { Command } from './utils';

export type TranslationTarget = 'ja' | 'zh-Hant' | 'en' | 'auto';
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function resolveTranslationTarget(text: string, env: Env, command: Command | null): TranslationTarget {
	if (command === 'jp-en') return 'en';
	if (command === 'jp-tw') return 'zh-Hant';
	if (command === 'tw-jp' || command === 'en-jp') return 'ja';
	if (env.TRANSLATION_MODE === 'ja2zh') return 'zh-Hant';
	if (env.TRANSLATION_MODE === 'zh2ja') return 'ja';
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
