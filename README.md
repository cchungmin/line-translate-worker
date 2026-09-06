# LINE Translate Worker

LINE bot translation worker powered by OpenAI and Cloudflare Workers.

## Requirements

- Node.js `>=24.0.0` (Node 24 is used in CI)
- pnpm `11.7.0` via Corepack
- Cloudflare account + Wrangler
- LINE Messaging API channel
- OpenAI API key

## Setup

1. Enable pnpm and install dependencies:
   - `corepack enable`
   - `corepack prepare pnpm@11.7.0 --activate`
   - `pnpm install`
2. Configure secrets:
   - `pnpm exec wrangler secret put LINE_CHANNEL_SECRET`
   - `pnpm exec wrangler secret put LINE_CHANNEL_ACCESS_TOKEN`
   - `pnpm exec wrangler secret put OPENAI_API_KEY`
3. Optional secret for precise mention matching:
   - `pnpm exec wrangler secret put LINE_BOT_USER_ID`
4. Deploy once to create the required Durable Object binding for atomic idempotency and rate limiting:
   - `pnpm deploy`

## Runtime Vars (`wrangler.jsonc`)

- `OPENAI_MODEL` (current default: `gpt-4o-mini`)
- `OPENAI_FALLBACK_MODEL` (current default: `gpt-4.1-mini`)
- `TRANSLATION_MODE` (`auto | ja2zh | zh2ja`)
- `TRANSLATION_STYLE` (`business | casual | neutral | polite`)
- `TRIGGER_MODE` (`all | mention | direct`)
  - For private messages: `all` and `direct` translate automatically; `mention` requires an explicit tag.
  - Groups and rooms always follow `GROUP_TRANSLATION_ENABLED` and explicit-tag rules below.
- `TRIGGER_MENTION`
- `GROUP_TRANSLATION_ENABLED` (`true | false`, default `false`)
  - `true`: translate every text message in groups and rooms.
  - `false`: groups and rooms translate only when the bot is explicitly tagged (`@翻譯` or a command tag).
- `DEBUG_LOG` (`true | false`)
- `MAX_INPUT_CHARS`
- `MAX_OUTPUT_TOKENS`
- `OPENAI_TIMEOUT_MS`
- `MAX_WEBHOOK_BODY_BYTES` (default: `65536`)
- `RATE_LIMIT_PER_MIN`
- `IDEMPOTENCY_TTL_SECONDS`
- `ERROR_REPLY_ENABLED`

The Worker explicitly sends `store: false` to OpenAI. It does not persist message text; the Durable Object stores only event IDs with logical expiration timestamps and rate-limit counters. Expired IDs are removed on a subsequent accepted request, so inactive conversations can retain expired IDs beyond the deduplication window.

LINE API calls have a five-second timeout. A delivery or event-processing failure is logged without message text and does not stop subsequent events in the same batch. Failed replies are not automatically retried; this avoids duplicate delivery when a timeout leaves the upstream outcome unknown.

## Local Run

- `pnpm dev`

## Validation

- `pnpm run typecheck`
- `pnpm test -- --run`
- CI runs both commands on pull requests and pushes to `main`.

## Deploy

- `pnpm deploy`
- Continuous deployment is not configured yet. Add it separately after defining the Cloudflare environment and repository secrets.

## Debug Runbook

1. Set `DEBUG_LOG` to `true`.
2. Deploy.
3. Check logs with `pnpm exec wrangler tail` or Cloudflare dashboard.
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
