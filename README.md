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
   - Run typecheck and tests, open a PR, and wait for CI before release.
- `pnpm deploy` deploys the current checkout; record its Git commit and Wrangler version in the PR.
- Verify the deployed version and the public health response. A health check does not exercise LINE/OpenAI credentials.
- Roll back code with `pnpm exec wrangler rollback <previous-version-id>` if needed. Saved conversation modes survive code rollback; a pre-controls version ignores them.

## Runtime Vars (`wrangler.jsonc`)

- `OPENAI_MODEL` (current default: `gpt-4o-mini`)
- `OPENAI_FALLBACK_MODEL` (current default: `gpt-4.1-mini`)
- `TRANSLATION_MODE` (`auto | ja2zh | zh2ja`)
- `TRANSLATION_STYLE` (`business | casual | neutral | polite`)
- `TRIGGER_MODE` (`all | mention | direct`; deployed default: `direct`)
  - For private messages: `all` and `direct` translate automatically; `mention` requires an explicit tag.
  - Groups and rooms initially follow `GROUP_TRANSLATION_ENABLED`. Saved conversation settings override these defaults.
- `TRIGGER_MENTION`
- `GROUP_TRANSLATION_ENABLED` (`true | false`; deployed default: `true`, unset fallback: `false`)
  - `true`: automatically translate meaningful text in groups and rooms.
  - `false`: groups and rooms translate only when the bot is explicitly tagged (`@翻譯` or a command tag).
- `DEBUG_LOG` (`true | false`)
- `MAX_INPUT_CHARS`
- `MAX_OUTPUT_TOKENS`
- `OPENAI_TIMEOUT_MS`
- `MAX_WEBHOOK_BODY_BYTES` (default: `65536`)
- `RATE_LIMIT_PER_MIN`
- `IDEMPOTENCY_TTL_SECONDS`
- `ERROR_REPLY_ENABLED`

The Worker explicitly sends `store: false` to OpenAI. It does not persist message text; the Durable Object stores conversation mode (including a timed pause deadline), event IDs with logical expiration timestamps, and rate-limit counters. Expired IDs are removed on a subsequent accepted request, so inactive conversations can retain expired IDs beyond the deduplication window.

Translation responses use [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) with a strict `translation` string field. Both configured models must support Chat Completions `json_schema`. The Worker validates completion status and the response schema, then sends only the field's text to LINE. Malformed, empty, refused, or truncated responses are rejected and can use the configured fallback model once; raw model output is never forwarded as an error recovery path. JSON that is part of the translated text itself is preserved.

Translation responses use [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) with a strict `translation` string field. Both configured models must support Chat Completions `json_schema`. The Worker validates completion status and the response schema, then sends only the field's text to LINE. Malformed, empty, refused, or truncated responses are rejected and can use the configured fallback model once; raw model output is never forwarded as an error recovery path. JSON that is part of the translated text itself is preserved.

LINE API calls have a five-second timeout. A delivery or event-processing failure is logged without message text and does not stop subsequent events in the same batch. Failed replies are not automatically retried; this avoids duplicate delivery when a timeout leaves the upstream outcome unknown.

## Shared controls / 共通操作

Private chats and groups now start with automatic Japanese ↔ Traditional Chinese translation in the checked-in deployment configuration. Existing conversations without a saved mode adopt these defaults. Each conversation can independently change its mode; **any member** can use the controls (not admin-only).

| Command | 中文 | 日本語 |
| --- | --- | --- |
| `/auto` | 開啟自動翻譯 | 自動翻訳 ON |
| `/pause` | 暫停自動翻譯 | 自動翻訳 OFF |
| `/pause 1h` | 暫停一小時後恢復自動翻譯 | 1時間後に自動翻訳を再開 |
| `/t 原文` | 單次翻譯，自動判斷台日方向 | その文だけ翻訳（言語を自動判定） |
| `/help` | 查看狀態與操作說明 | 状態と使い方を表示 |

- On follow/join and after a control command, bilingual replies offer LINE quick-reply buttons. [Quick replies](https://developers.line.biz/en/docs/messaging-api/using-quick-reply/) appear on iOS/Android and disappear after another message; `/help` brings them back. Desktop users can type the same ASCII commands.
- Only a complete command at the start of the message changes mode (case-insensitive, surrounding whitespace allowed). Ordinary text mentioning `pause` or `auto` cannot change settings. Unsupported forms such as `/pause 2h` are ordinary text.
- `/t` and legacy tags (`@翻譯`, `@TWJP`, `@JPTW`, etc.) still work while paused. Empty `/t` shows help. Control requests never call OpenAI.
- A timed pause resumes on the first event at or after its deadline, without a scheduled notification. The displayed deadline is UTC. `/pause` cancels a timed resume and pauses indefinitely; `/auto` resumes immediately.
- Stickers, emoji-only text, and pure HTTP(S) links are skipped. Short meaningful messages such as `好`, `不要`, and `はい` remain eligible.
- Mode and event deduplication are persisted in one Durable Object write. Translation and control requests have separate per-minute counters (both use `RATE_LIMIT_PER_MIN`), so a busy translation queue does not block pausing. Existing state is compatible; no migration or message-history storage is required.
- As before, deduplication is bounded by `IDEMPOTENCY_TTL_SECONDS`; retries beyond that window may be processed again. Modes persist across bot removal/rejoin; `/auto` resets a saved pause.

## Local Run

- `pnpm dev`

## Bot Icon

- New profile image: [line-translate-icon-v2.png](assets/line-translate-icon-v2.png).
- Interlocking speech bubbles with `文` and `あ`, designed with margins for a circular avatar crop.
- Upload the PNG as the bot's profile image in LINE's account management interface; deploying the Worker does not change the profile image.
- Generation method and full prompt: [icon design notes](assets/line-translate-icon-v2.md).
- Matching cover photo: [line-translate-cover-v2.png](assets/line-translate-cover-v2.png), cropped to 2:1 in LINE's profile editor. [Cover design notes and prompt](assets/line-translate-cover-v2.md).

## Validation

- `pnpm run typecheck`
- `pnpm exec vitest run`
- CI runs both commands on pull requests and pushes to `main`.

## Deploy

- Run typecheck and tests, open a PR, and wait for CI before release.
- `pnpm deploy` deploys the current checkout; record its Git commit and Wrangler version in the PR.
- Verify the deployed version and the public health response. A health check does not exercise LINE/OpenAI credentials.
- Roll back code with `pnpm exec wrangler rollback <previous-version-id>` if needed. Saved conversation modes survive code rollback; a pre-controls version ignores them.
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


## Translation direction

For automatic Japanese/Traditional Chinese translation, text without kana defaults to Japanese, including Chinese and ambiguous Han-only phrases. Text containing kana retains model judgment within the Japanese/Traditional Chinese pair, so Chinese quotations of Japanese can still be interpreted by context. Neither automatic path requests English. Explicit language tags and fixed `TRANSLATION_MODE` settings take precedence; language tags are recognized only at the beginning of the text after stripping the bot mention.

A conservative output check rejects all-Latin sentences of at least three words for CJK input when English was not requested, and uses the configured fallback once. Short names, numbers, links, and Latin words already in the source are exempt. This catches the reported `你能自動翻譯了嗎？` → `Can you translate automatically?` regression; it is not a complete language or translation-quality detector. Tests simulate both wrong primary output and fallback recovery; they do not establish live model accuracy.
