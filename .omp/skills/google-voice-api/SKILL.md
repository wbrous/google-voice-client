---
name: google-voice-api
description: "Use when working on this library's Google Voice API integration — the undocumented sendMessage/list/download wire contract, SAPISIDHASH auth, event polling, and session-cookie renewal. Ground truth lives in src/ and AGENTS.md; this skill is the working summary."
---

# google-voice-api — this project's contract

Unofficial client for Google Voice's internal (undocumented) web API. The
authoritative wire-format knowledge is in `AGENTS.md` and `src/parse.ts`;
`src/*.ts` are the live implementation. This skill is the working summary to
orient quickly — if it contradicts `src/`, **the code wins** (Google changes
internals; re-derive from a fresh capture and update both).

## Endpoints (all `POST …/voiceclient/…?alt=protojson&key=<publicKey>`)

- `api2thread/sendsms` — send. Body `[null,null,null,null,text,threadId,null,null,[tmpId],mediaField,botguardField]`.
  - `text` = plaintext body verbatim. `mediaField` = `[2, base64]` (photo) or null.
  - `botguardField` = `[wsaToken, null, null, recaptchaToken]`; **without it the server 401s**. Tokens are session-recent, not text-bound.
  - Attachment cap ~1 MB default; re-encode via `sharp` when `opts.compress`.
- `api2thread/list` — read. Body `[2,100,50]` (empty `[]` → 400). Response `[threads,…]` → each `[threadId,_,events]`.
  - Event row (0-indexed): `5`=direction (0 recv, 1 sent), `9`=SMS text **or** MMS label, `14`=MMS content (caption+attachments) or null, `15`=other party, `17`=tmpId, `last`=threadId.
  - Attachments: images carry sizes `[[code,w,h],…]`; **videos have `null` sizes** — decode as `[]`.
- Attachment bytes: `GET https://voice.google.com/u/{authUser}/a/i/{id}?s={sizeCode}` — plain cookie, no SAPISIDHASH.

## Auth

`SAPISIDHASH` = `{ts}_{sha1hex("{ts} {sapisid} https://voice.google.com")}`; the
three hashes (SAPISID/1P/3P) share one digest. **Field order matters**: `ts
SPACE sapisid SPACE origin` — swap middle and it 401s. `ts` = fresh unix
seconds per request.

## Event loop (client uses HTTP polling, not a websocket)

`client.on("messageCreate"|"messageUpdate"|"ready"|"disconnect"|"messageSend")`
+ `client.start({intervalMs})`. Voice has **no SMS push channel**, so the loop
diffs `listThreads()` snapshots; `disconnect` fires on a poll error (stale
401) and stops the loop.

## Session cookies & renewal

- `SIDCC`/`__Secure-{1,3}PSIDCC` rotate in minutes-hours (the recurring 401).
  Long-lived `SID`/`SAPISID` last months.
- Renewal is browser-only: `accounts.google.com/RotateCookies` mints a token
  via page JS — not reproducible with plain HTTP. App passwords don't map to
  web sessions; no OAuth scope exists for consumer Voice.
- `readFirefoxSession()` (sqlite) / `readBrowserSession()` (`@mherod/get-cookie`
  peer for Chromium/Safari) / `refreshCookies()` (Playwright) — see
  `src/browser.ts`, `src/refresh.ts`.

## Do / don't

- Keep `playwright` + `@mherod/get-cookie` as **optional peers**, externalized
  in `bun build`; `refresh.ts` uses local structural types so consumers
  without the peer stay type-safe.
- Tests must not hit the live API — use fixture rows / synthetic `moz_cookies`.
- Real API keys: never commit literal values; write `AIzaSy<…>` placeholders
  (gitleaks scans staged files).
- When behavior changes after a live re-capture, update `AGENTS.md` +
  `src/parse.ts` **and** this skill together.
