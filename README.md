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
- `pnpm deploy` requires a clean `main` checkout matching freshly fetched `origin/main`, and verifies that the queue exists before deploying. Feature branches and unreviewed local commits are rejected. `node scripts/deploy.mjs --check` runs only the Git preflight. Record the deployed Git commit and Wrangler version in the PR.
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
- `AUTO_TRANSLATION_ENABLED` (`true | false`, default `true`): emergency upper bound for automatic translation in every conversation. `false` overrides saved `/auto` settings but keeps explicit `/t`, language tags and controls available. Restoring `true` restores each saved preference.
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

The Worker explicitly sends `store: false` to OpenAI. Message text is not stored in Durable Objects or logs. Pending webhook batches (including text and reply tokens) are temporarily persisted in Cloudflare Queues until acknowledged or expired; provision the queue with a 300-second retention limit as described below. The Durable Object stores conversation mode (including a timed pause deadline), event IDs with logical expiration timestamps, and rate-limit counters. Expired IDs are removed on a subsequent accepted request, so inactive conversations can retain expired IDs beyond the deduplication window.

Translation responses use [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) with a strict `translation` string field. Both configured models must support Chat Completions `json_schema`. The Worker validates completion status and the response schema, then sends only the field's text to LINE. Malformed, empty, refused, or truncated responses are rejected and can use the configured fallback model once; raw model output is never forwarded as an error recovery path. JSON that is part of the translated text itself is preserved.

Translation responses use [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) with a strict `translation` string field. Both configured models must support Chat Completions `json_schema`. The Worker validates completion status and the response schema, then sends only the field's text to LINE. Malformed, empty, refused, or truncated responses are rejected and can use the configured fallback model once; raw model output is never forwarded as an error recovery path. JSON that is part of the translated text itself is preserved.

LINE API calls have a five-second timeout. Unrequested automatic group/room translations fail silently (structured logs only); explicit commands and private-chat failures still receive errors when enabled. Oversize automatic messages are skipped before admission; explicit oversize requests receive an error without consuming a translation slot. Identical automatic translations are suppressed; explicit requests still receive the result. A delivery or event-processing failure is logged without message text and does not stop subsequent events in the same batch. Failed replies are not automatically retried; this avoids duplicate delivery when a timeout leaves the upstream outcome unknown.

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
- `pnpm run test:release`
- CI runs both commands on pull requests and pushes to `main`.

## Deploy

- Run typecheck and tests, open a PR, and wait for CI before release.
- `pnpm deploy` requires a clean `main` checkout matching freshly fetched `origin/main`, and verifies that the queue exists before deploying. Feature branches and unreviewed local commits are rejected. `node scripts/deploy.mjs --check` runs only the Git preflight. Record the deployed Git commit and Wrangler version in the PR.
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

For automatic Japanese/Traditional Chinese translation, all CJK input (including Han-only Japanese such as `了解`, `承知`, `明日会議`, and `東京駅`) uses model judgment restricted to that language pair: Chinese → Japanese and Japanese → Traditional Chinese, defaulting to Japanese only when ambiguous. Absence of kana does not identify the source language. Non-CJK input defaults to Japanese. English is never an automatic target. Explicit language tags and fixed `TRANSLATION_MODE` settings take precedence; language tags are recognized only at the beginning of the text after stripping the bot mention.

A conservative output check rejects all-Latin sentences of at least three words for CJK input when English was not requested, and uses the configured fallback once. Short names, numbers, links, and Latin words already in the source are exempt. This catches the reported `你能自動翻譯了嗎？` → `Can you translate automatically?` regression; it is not a complete language or translation-quality detector. Tests simulate both wrong primary output and fallback recovery; they do not establish live model accuracy.


## Durable webhook processing

The signed webhook is acknowledged with HTTP 200 only after its complete supported-event batch has been accepted by `LINE_EVENT_QUEUE`; enqueue failure or a missing binding returns 503. Enable LINE webhook redelivery in the channel settings for retrying failed acceptance. Empty verification requests still return 200. Incoming bodies are capped at 64 KiB to fit safely inside a queue message.

The queue consumer awaits each event in order, outside the HTTP `waitUntil` lifetime. The consumer batch size is one webhook, with no intentional batching delay and at most ten concurrent consumer invocations. Queues can reorder separate webhooks: timestamps prevent an older mode-changing command from overwriting a newer one; this is not a promise of global message ordering. Controls within the same webhook retain their original order.

Reply tokens are time-sensitive. Work older than 55 seconds from webhook receipt is discarded with `event_expired_before_processing`, rather than spending on unusable replies. OpenAI attempts are capped at eight seconds each and share a deadline reserving five seconds for LINE. A slow or backlogged queue may still lose reply opportunities; durable acceptance does not guarantee an eventual LINE reply. Monitor `queue_retry_exhausted`, expiry logs and queue age. No push-message fallback is used.

A guard failure before admission is retried up to three times with a one-second delay. Already claimed events are deduplicated. As before, admission is at-most-once within the configured TTL: an unexpected crash after claiming an event can leave that event unanswered, and uncertain LINE sends are not retried automatically. No full exactly-once delivery claim is made. There is no dead-letter queue retaining expired content.

### First release after review

1. Merge #26 first; retarget #25 to `main`, rerun CI, then merge #25. A merge commit for #26 preserves the shared ancestry; squash requires resolving the stacked history before #25 merges.
2. Check out and fast-forward `main`, then run typecheck, Workers tests and release-preflight tests.
3. Provision the new queue explicitly: `pnpm exec wrangler queues create line-translate-events --message-retention-period-secs 300`. Confirm the retention in Cloudflare before release. If the account plan rejects short retention, stop and resolve it; do not silently accept a longer default. No production queue has been created by this PR.
4. Enable LINE webhook redelivery if it is off, then run `pnpm deploy` from clean synchronized `main`. Check the consumer binding, queue age, HTTP health and a real LINE translation.
5. The emergency switch is `AUTO_TRANSLATION_ENABLED=false`; changing `GROUP_TRANSLATION_ENABLED` or `TRIGGER_MODE` changes defaults only. Align emergency dashboard changes back into the repository before a later deployment.

The queue adds temporary storage and queue operations to the existing Worker/DO costs. It is transport buffering, not chat history, and must not be used as a conversation-context store. Rollback to the currently published pre-queue Worker must also account for the consumer attachment: stop intake/consumer processing and purge pending content deliberately rather than leaving an incompatible consumer bound.
