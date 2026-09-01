---
name: har-analysis
description: "Use when analyzing a HAR capture of voice.google.com traffic for this library — finding where a message/attachment value lives on the wire, decoding sendsms/list payloads, detecting redacted cookies, or extracting a live session to refresh .env."
---

# HAR analysis for google-voice-client

Project: this repo is a client for Google Voice's internal web API. When a
network capture (`*.har`) of voice.google.com is provided, use this guide to
extract the ground truth this library needs. The wire-format contract lives
in `AGENTS.md` and `src/parse.ts` — this file is the technique, not the spec.

## Reading a HAR

HARs are large (10s of MB). Do not `read` them whole.

- Use `grep`/bash byte-offset extraction, or load the JSON once in the eval
  kernel (`json.load`) and filter `log.entries` by request URL.
- The curl with `-o`/`dd` + byte offsets works for spot-reading around a
  marker: `grep -abo "<marker>" file.har` then `dd ... skip=offset count=N`.

## Finding where a value lives on the wire

If you don't know which request carries a piece of data:

1. Look at the UI: what got displayed in voice.google.com?
2. Filter entries by method + URL: sends are `POST .../api2thread/sendsms`,
   reads are `POST .../api2thread/list`, attachments are
   `GET https://voice.google.com/u/{authUser}/a/i/{id}`.
3. The `sendsms` request body is a positional JSON array — index 4 is the
   plaintext text, index 9 is `[2, base64ImageBytes]` for photo MMS, index
   10 is `[wsaToken, null, null, recaptchaToken]`.
4. The `list` response rows carry SMS text **verbatim** at index 9; MMS rows
   put the real content (caption + attachments) at index 14. Video
   attachments have `sizes: null` — never `.map` over it.

## Detecting redacted captures

Firefox HAR export strips `Cookie`/`Authorization` values unless "Include
sensitive data" was checked. Symptom: the library 401s on a fresh capture, or
the `Authorization` SAPISIDHASH doesn't recompute from the request's own
cookie. Verify with `computeSapisidHash` (see auth docs).

## Extracting a session for .env

- **Firefox-family** (incl. Zen): copy `cookies.sqlite{,-wal,-shm}` from the
  profile to a temp dir and query `moz_cookies` where `host LIKE '%google.com'`
  — the Live browser may hold an exclusive lock, so never open the file in
  place.
- **Chromium-family/Safari**: cookies are encrypted; use the `@mherod/get-cookie`
  peer via `readBrowserSession()`, not manual SQL.

## Decoding curl bodies

`curl --data-raw $'...'` bodies use octal escapes (e.g. `\041` = `!`). Decode
with python `json.loads` after `printf` — never trust the raw shell-quoted
string in an eval cell.

## Gotchas

- The `key`/`X-Goog-Api-Key` param is a public browser-shipped constant —
  never treat it as a secret or try to redact it (but don't paste real key
  *values* into committed docs — gitleaks flags `AIzaSy...`).
- Boolean/flag fields in `list` rows are positional; a mis-indexed field
  yields garbage like `"MMS Sent"` where real text should be.
