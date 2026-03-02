# LINE Translate Worker

Cloudflare Worker that receives LINE webhook messages, translates text with OpenAI, and replies back to LINE.

## Requirements

- Node.js `>=20.0.0`
- Cloudflare account + Wrangler
- LINE Messaging API channel
- OpenAI API key

## Setup

1. Install dependencies:
   - `npm install`
2. Configure secrets:
   - `npx wrangler secret put LINE_CHANNEL_SECRET`
   - `npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN`
   - `npx wrangler secret put OPENAI_API_KEY`
3. Optional secret for precise mention matching:
   - `npx wrangler secret put LINE_BOT_USER_ID`
4. Optional KV for idempotency/rate limit:
   - Create KV namespace
   - Add binding `APP_KV` in `wrangler.jsonc`

## Runtime Vars (`wrangler.jsonc`)

- `OPENAI_MODEL`
- `OPENAI_FALLBACK_MODEL`
- `TRANSLATION_MODE` (`auto | ja2zh | zh2ja`)
- `TRANSLATION_STYLE` (`business | casual`)
- `TRIGGER_MODE` (`all | mention | direct`)
- `TRIGGER_MENTION`
- `DEBUG_LOG` (`true | false`)
- `MAX_INPUT_CHARS`
- `MAX_OUTPUT_TOKENS`
- `OPENAI_TIMEOUT_MS`
- `RATE_LIMIT_PER_MIN`
- `IDEMPOTENCY_TTL_SECONDS`
- `ERROR_REPLY_ENABLED`

## Local Run

- `npm run dev`

## Deploy

- `npx wrangler deploy`

## Debug Runbook

1. Set `DEBUG_LOG` to `true`.
2. Deploy.
3. Check logs with `wrangler tail` or Cloudflare dashboard.
4. For bot profile debug:
   - `GET /debug/bot-info?debug=1`
5. Set `DEBUG_LOG` back to `false` after troubleshooting.

## Failure Modes

- `Invalid signature`: wrong `LINE_CHANNEL_SECRET`.
- OpenAI `insufficient_quota`: billing/quota issue.
- No reply in group mention mode:
  - Mention metadata may be absent for plain text tags.
  - Use command tags (`@TWJP`, `@JPTW`, `@ENJP`, `@JPEN`) or configure `LINE_BOT_USER_ID`.
