import type { Env } from '../types';
import type { LineBotInfo } from '../utils';

export async function replyLineMessage(
	replyToken: string,
	text: string,
	env: Env,
): Promise<{ ok: true } | { ok: false; status: number; body: string }> {
	const response = await fetch('https://api.line.me/v2/bot/message/reply', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
		},
		body: JSON.stringify({
			replyToken,
			messages: [{ type: 'text', text: text.slice(0, 5000) }],
		}),
	});

	if (response.ok) {
		return { ok: true };
	}

	return {
		ok: false,
		status: response.status,
		body: await response.text(),
	};
}

export async function fetchLineBotInfo(env: Env): Promise<LineBotInfo | null> {
	const response = await fetch('https://api.line.me/v2/bot/info', {
		headers: {
			Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
		},
	});
	if (!response.ok) {
		return null;
	}
	return (await response.json()) as LineBotInfo;
}
