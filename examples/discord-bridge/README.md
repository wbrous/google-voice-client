# Google Voice ↔ Discord bridge (selfbot)

Bridges one Google Voice phone number with one Discord DM by logging in as
**your own Discord user account** (a "selfbot"). When the phone receives a
message it is DM'd to the bridged user; when the bridged user DMs back, it is
delivered to the phone.

> **⚠️ Discord ToS warning**
>
> This logs into Discord with a *user* token, which Discord forbids
> ("selfbot"). Discord deactivates accounts detected doing this — it is a
> ban-risk on the account, not a gray area. Use a regular bot token instead
> unless you specifically need a user account. This example is provided
> as-is; running it against a real account is your own risk.

## Setup

1. Register the local `google-voice-client` link once (the bridge depends on
   it via `link:`, not a published npm version):
   ```bash
   cd ..    # repo root
   bun link
   ```
2. Install the bridge deps:
   ```bash
   cd examples/discord-bridge
   bun install
   ```
3. Create the Google Voice session (see the main repo's `.env.example` — needs
   `GV_COOKIE`, `GV_API_KEY`, `GV_SAPISID`, etc.).

4. Get your Discord **user token** (Developer Mode → the account you'll run as)
   and the **user id** of the person whose DM you're bridging.

## Environment

| Variable | Purpose |
|----------|---------|
| `GV_COOKIE` / `GV_API_KEY` / `GV_SAPISID` / `GV_AUTH_USER` | Google Voice session (see main repo) |
| `DISCORD_TOKEN` | Your Discord **user** token (selfbot) |
| `BRIDGE_DM_USER_ID` | Discord user whose DM is bridged |
| `BRIDGE_PHONE` | E.164 phone, e.g. `+14697590653` |
| `GV_SEND_ATTESTATION_TOKEN` / `GV_SEND_RECAPTCHA_TOKEN` | Required for Discord→phone sends (auto-refreshed, see below) |

## Run

```bash
bun run start
```

## How it works

- **Voice → Discord**: `GoogleVoiceClient`'s event loop detects an incoming
  message from `BRIDGE_PHONE` and DMs it to `BRIDGE_DM_USER_ID` (photo
  attachments are downloaded and sent as files). The selfbot ignores its own
  messages, so a forward never echoes back.
- **Discord → Voice**: a DM from `BRIDGE_DM_USER_ID` is sent to the phone via
   `sendMessage` (a leading `<@mention>` quote is stripped). Images you send
   in the DM are uploaded as MMS photo attachments.

`BRIDGE_PHONE` matches leniently: leading `+`, country-code differences, and
spacing are tolerated (`4697590653` and `+14697590653` both match), so you
don't have to get the exact E.164 spelling right.

## Caveats

- **Outbound sends need the WAA/BotGuard + reCAPTCHA tokens** Google's web
   client mints (the SDK cannot fabricate them; they're session-recent and
   expire in minutes-to-hours, so they need periodic re-capture). Refresh
   them with:

   ```bash
   bun run capture-tokens          # capture once
   LOOP=1 bun run refresh-tokens-loop   # capture, then every REFRESH_MINUTES (default 60)
   ```

   `bin/refresh-tokens.ts` drives a real headless Chromium session against an
   **existing** Voice thread for `BRIDGE_PHONE` (found by matching the
   thread-list `itemId` to the phone's digits, not by contact-name text —
   works whether or not the number is a saved Google Contact), sends
   `[AUTOMATED] Refreshing tokens...` through it, intercepts the resulting
   `sendsms` request for the token pair, and writes `GV_SEND_ATTESTATION_TOKEN`
   / `GV_SEND_RECAPTCHA_TOKEN` into `.env`. Requires at least one prior
   message already exchanged with `BRIDGE_PHONE` (a thread must already
   exist — Voice's anti-abuse flow only mints tokens for a real send, and a
   synthetic *new* conversation to a raw, non-contact number never fires).

   Without tokens the bridge logs that outbound is disabled and keeps
   forwarding inbound.
- Selfbot libraries (here: `discord.js-selfbot-youtsuho-v13`, a fork of the
  archived `discord.js-selfbot-v13`) track Discord API changes loosely; a
  Discord update may break login until the fork catches up. See the fork's
  GitHub for the latest state.

## Troubleshooting

Set `DEBUG=1` in the bridge `.env` and restart for verbose logs of every
Voice event and Discord message, plus each filter decision (direction check,
phone-match, own-message loop guard, DM-channel check). If a Voice message
isn't relaying, the debug output will show which check rejected it — a common
cause is `BRIDGE_PHONE` not matching the sender's number exactly (e.g. `+` vs
no `+`, or a country-code difference).

Run with:

```bash
DEBUG=1 bun run start
```
