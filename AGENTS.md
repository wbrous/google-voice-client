# AGENTS.md

Guidance for AI agents and contributors working in this repository. Project-specific only — engineering philosophy lives in global agent config.

## What this is

Unofficial [Bun](https://bun.sh) + TypeScript client for Google Voice's **internal, undocumented** web API. It authenticates by replaying a real browser session (SAPISIDHASH-signed), not OAuth. Tests hit a mock DB or pure functions only — **no live API calls in the test suite**.

## Layout

- `src/client.ts` — `GoogleVoiceClient` (sendMessage, listThreads, downloadAttachment). **Only file that does HTTP.** Extends `node:events` EventEmitter + has a poll loop (`start`/`stop`) that diffs `listThreads()` snapshots and emits `ready`/`messageCreate`/`messageUpdate`/`disconnect`; `sendMessage` emits `messageSend`.
- `src/events.ts` — `ClientEventMap`/`VoiceClientEvent` typing for the EventEmitter. **Voice has no SMS push channel** — the "events" are HTTP polling, so the poll loop `unref()`s its timer and `disconnect` stops it on a 401.
- `src/parse.ts` — decode `api2thread/list` positional-array rows into typed objects. Wire format knowledge lives here.
- `src/auth.ts` — SAPISIDHASH computation. **Critical:** SHA-1 input order is `{ts} {sapisid} {origin}` — swap the middle two and every request 401s.
- `src/firefox.ts` / `src/browser.ts` — read session cookies from a browser profile (`cookies.sqlite` for Firefox-family, `@mherod/get-cookie` optional peer for Chromium/Safari).
- `src/refresh.ts` — headless Playwright login fallback (optional peer).
- `src/env.ts` — read/write `.env` credentials (`GV_COOKIE`, `GV_API_KEY`, `GV_AUTH_USER`, ...).
 - `bin/refresh-cookies.ts` — CLI: refresh `.env` from a browser jar or Playwright.
- `test/` — bun:test. Tests use fixture rows / synthetic `moz_cookies` DBs.

## Example: Discord bridge

- `examples/discord-bridge/` — a runnable app (own package.json + `discord.js`)
  that bridges one phone number with one Discord DM via this library's event
  loop (see its README). It's a separate package so its `discord.js` dep never
  pollutes the published lib. It depends on `google-voice-client` via
  `"file:../.."` — after changing library code, rebuild the parent
  (`bun run build`) before testing the bridge.

## Wire-format rules (from live capture — do not "fix" these)

- `api2thread/list` **event row** (0-indexed): index `5` = direction flag (0=received, 1=sent), index `9` = SMS text **or** MMS type label (`"MMS Sent"`/`"MMS Received"`) — NOT content, index `14` = MMS content `[caption,_,attachments,...]` or `null`, index `15` = other party, index `17` = tmpId, last = threadId.
- **MMS gotcha:** reading index 9 for text on an MMS event yields the fixed label garbage. Real content is index 14.
- Attachment entry: `[mimeType, idWithDashSuffix, _, sizes, ...]`. Images have `sizes=[[code,width,height],...]`; **videos have `sizes=null`** → decode as empty variants, don't crash.
- `api2thread/sendsms` request body: `[null,null,null,null,text,threadId,null,null,[Number(tmpId)],mediaField,botguardField]`. `mediaField` = `[2, base64ImageBytes]` or null; `botguardField` = `[attestationToken, null, null, recaptchaToken]` or null.
- `sendsms` without the botguard field → server **401**. Tokens are session-recent, NOT message-bound (replay with different text works for a short window).
- Attachment download: `GET https://voice.google.com/u/{authUser}/a/i/{attachmentId}?s={sizeCode}` — plain cookie auth, no SAPISIDHASH.

## Auth & cookies

- `SIDCC`/`__Secure-{1,3}PSIDCC` expire in minutes-hours (the classic 401). Long-lived `SID`/`SAPISID` last months.
- Browser rotation happens via `accounts.google.com/RotateCookies` — token minted by page JS, **cannot** be reproduced with plain HTTP. Use `refreshCookies()` (Playwright) or `readFirefoxSession()` (sqlite) instead.
- The Playwright login profile is single-account → **`GV_AUTH_USER=0`**. A `1` from a multi-account browser jar 401s in it.
- `writeEnvVar(name, value)` persists `.env` lines; `writeEnvCookie` delegates to it.

## Build & publish

- Build: `bun build ./src/index.ts --external playwright --external @mherod/get-cookie && tsc` — **both optional peers are externalized** (not bundled).
- Playwright is an intentional dynamic `import()` and uses **local structural types** (no `import type ... from "playwright"`) so consumers without it stay type-safe and tree-shakeable. Keep it that way.
- `bun pm pack` must ship only: README, LICENSE, package.json, `dist/**`. Check `bun pm pack --dry-run` after touching the build config.
- TS rule: use `Record<K,V>` (not `Set`) for static string-keyed lookup tables, per global config.
