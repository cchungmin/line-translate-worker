import type { Env } from './types';

type LogLevel = 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

export function log(env: Env, level: LogLevel, message: string, fields: LogFields = {}): void {
	if (level === 'info' && env.DEBUG_LOG !== 'true') {
		return;
	}

	const payload = {
		level,
		message,
		...fields,
	};

	if (level === 'error') {
		console.error(JSON.stringify(payload));
		return;
	}
	if (level === 'warn') {
		console.warn(JSON.stringify(payload));
		return;
	}
	console.log(JSON.stringify(payload));
}
