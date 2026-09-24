export type Control = 'auto' | 'pause' | 'pause1h' | 'help';
export type ConversationMode = { auto: boolean; resumeAt?: number };
export type ChatCommand = { control: Control } | { text: string };

export function parseChatCommand(text: string): ChatCommand | null {
	const input = text.trim();
	if (/^\/auto$/i.test(input)) return { control: 'auto' };
	if (/^\/pause$/i.test(input)) return { control: 'pause' };
	if (/^\/pause\s+1h$/i.test(input)) return { control: 'pause1h' };
	if (/^\/help$/i.test(input) || /^\/t$/i.test(input)) return { control: 'help' };
	const translate = /^\/t\s+([\s\S]+)$/i.exec(input);
	return translate ? { text: translate[1].trim() } : null;
}

export function hasTranslatableText(text: string): boolean {
	// Ignore links and emoji-only chatter, but retain short words and numbers.
	return /[\p{L}\p{N}]/u.test(text.replace(/https?:\/\/\S+/gi, ''));
}

export function modeHelp(mode: ConversationMode, welcome = false): string {
	const status = mode.auto
		? '自動翻譯已開啟／自動翻訳 ON'
		: mode.resumeAt
			? `自動翻譯暫停中／自動翻訳を一時停止中\n自動恢復／自動再開：${new Date(mode.resumeAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`
			: '自動翻譯已暫停／自動翻訳 OFF';
	return [
		...(welcome ? ['你好！日台翻譯小幫手です。'] : []),
		status,
		'/auto — 自動翻譯／自動翻訳',
		'/pause — 暫停／停止',
		'/pause 1h — 暫停一小時／1時間停止',
		'/t 原文 — 單次翻譯／その文だけ翻訳',
		'/help — 操作說明／使い方',
		'暫停時仍可用 /t 或 @TWJP 等指令。\n停止中も /t や @TWJP などで翻訳できます。',
		'設定只影響此聊天室，所有成員皆可切換。\n設定はこのトークに適用され、全員が変更できます。',
	].join('\n');
}

export const controlQuickReply = {
	items: [
		['自動翻譯／自動翻訳', '/auto'],
		['暫停／停止', '/pause'],
		['暫停 1h／1時間停止', '/pause 1h'],
		['說明／使い方', '/help'],
	].map(([label, text]) => ({ type: 'action', action: { type: 'message', label, text } })),
};
