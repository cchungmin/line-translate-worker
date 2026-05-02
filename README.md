# LINE Translate Worker

LINE bot translation worker powered by OpenAI and Cloudflare Workers.

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
   - Without `APP_KV`, `RATE_LIMIT_PER_MIN` and idempotency checks are not enforced.

## Runtime Vars (`wrangler.jsonc`)

- `OPENAI_MODEL` (current default: `gpt-4.1-mini`)
- `OPENAI_FALLBACK_MODEL` (recommended fallback: `gpt-4o-mini`)
- `TRANSLATION_MODE` (`auto | ja2zh | zh2ja`)
- `TRANSLATION_STYLE` (`business | casual | neutral | polite`)
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

## Command Tags

- `@TWJP`, `@JPTW`, `@ENJP`, `@JPEN`
- Optional style suffix: `-N` (neutral/plain), `-P` (polite), `-B` (business)
- Examples:
  - `@TWJP 明天麻煩你確認一下` -> defaults to polite Japanese (`です・ます`)
  - `@TWJP-N 明天麻煩你確認一下`
  - `@TWJP-B 請協助安排下週會議`
  - `@JPTW-P お手数ですが、ご確認をお願いいたします`
