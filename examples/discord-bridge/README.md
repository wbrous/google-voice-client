# Google Voice ↔ Discord bridge

Bridges one Google Voice phone number with one Discord DM: messages the
phone receives are forwarded into your DM with the bot, and messages you
send in that DM are delivered to the phone.

## Setup

1. Install deps:
   ```bash
   cd examples/discord-bridge
   bun install
   ```

2. Create the Google Voice session in `.env` (see the main repo's
   `.env.example` — needs `GV_COOKIE`, `GV_API_KEY`, `GV_SAPISID`, etc.).
   Copy `.env.example` here and fill it in.

3. Create a Discord bot at <https://discord.com/developers/applications>,
   copy its token, and add it to your server (it needs the ability to DM you
   — bots can't initiate a DM until the user has sent the bot a message
   once).

4. Get your Discord user id (Developer Mode → copy user id) and your
   E.164 phone number (e.g. `+14697590653`).

## Environment

| Variable | Purpose |
|----------|---------|
| `GV_COOKIE` / `GV_API_KEY` / `GV_SAPISID` / `GV_AUTH_USER` | Google Voice session (see main repo) |
| `DISCORD_TOKEN` | Discord bot token |
| `BRIDGE_DM_USER_ID` | Discord user whose DM is bridged |
| `BRIDGE_PHONE` | E.164 phone, e.g. `+14697590653` |
| `GV_SEND_ATTESTATION_TOKEN` / `GV_SEND_RECAPTCHA_TOKEN` | Required for Discord→phone sends |

## Run

```bash
bun run start
```

## Important caveat: outbound sends

Receiving works with just the session cookie: incoming SMS/MMS to the bridged
phone are forwarded to Discord, including photo attachments.

**Sending** from Discord to the phone requires the anti-abuse tokens Google's
web client mints (WAA/BotGuard + reCAPTCHA) — the SDK does not mint them, and
Google's `sendsms` endpoint returns 401 without them. Set
`GV_SEND_ATTESTATION_TOKEN` and `GV_SEND_RECAPTCHA_TOKEN` to a freshly-captured
pair (from a real browser session's send request) to enable Discord→phone.
When they're unset the bot reports that sends are disabled but continues
forwarding phone→Discord.
