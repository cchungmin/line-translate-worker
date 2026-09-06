import type { Env } from '../types';
import type { LineBotInfo } from '../utils';

const LINE_TIMEOUT_MS = 5000;

export async function replyLineMessage(
	replyToken: string,
	text: string,
	env: Env,
): Promise<{ ok: true } | { ok: false; status: number; errorType?: 'timeout' | 'network' }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), LINE_TIMEOUT_MS);
	try {
		const response = await fetch('https://api.line.me/v2/bot/message/reply', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
			},
			signal: controller.signal,
			body: JSON.stringify({
				replyToken,
				messages: [{ type: 'text', text: text.slice(0, 5000) }],
			}),
		});

		await response.body?.cancel();
		return response.ok ? { ok: true } : { ok: false, status: response.status };
	} catch {
		return { ok: false, status: 0, errorType: controller.signal.aborted ? 'timeout' : 'network' };
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function fetchLineBotInfo(env: Env): Promise<LineBotInfo | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), LINE_TIMEOUT_MS);
	try {
		const response = await fetch('https://api.line.me/v2/bot/info', {
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
			},
		});
		if (!response.ok) {
			await response.body?.cancel();
			return null;
		}
		return (await response.json()) as LineBotInfo;
	} catch {
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}
