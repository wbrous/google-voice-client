/**
 * Selfbot bridge between one Google Voice phone number and one Discord DM.
 *
 * Logs in as YOUR OWN Discord user account (a "selfbot") and bridges the DM
 * you share with `BRIDGE_DM_USER_ID` to `BRIDGE_PHONE`:
 * - Voice → Discord: a message received on the phone is DM'd to the bridged
 *   user (attachments forwarded as files).
 * - Discord → Voice: a DM from the bridged user is delivered to the phone;
 *   images you send in the DM are uploaded back as MMS photos.
 *
 * ⚠️ SELF-BOT WARNING
 * Using Discord with a user token (a "selfbot") violates Discord's Terms of
 * Service. Discord deactivates accounts detected doing this. This example is
 * provided as-is; you accept full account-loss risk by running it against a
 * real account. Prefer a regular bot token unless you specifically need a
 * user account.
 *
 * Outbound (Discord → Voice) sends also require the anti-abuse tokens
 * Google's web client mints (WAA/BotGuard + reCAPTCHA); the SDK cannot mint
 * them. Set GV_SEND_ATTESTATION_TOKEN / GV_SEND_RECAPTCHA_TOKEN to replay a
 * fresh capture. Inbound needs only the session cookie.
 *
 * Environment:
 *   GV_COOKIE / GV_API_KEY / GV_SAPISID ...  Google Voice session
 *   DISCORD_TOKEN                           YOUR Discord **user** token
 *   BRIDGE_DM_USER_ID                       Discord user who is bridged
 *   BRIDGE_PHONE                            E.164 phone (e.g. +14697590653)
 *   GV_SEND_ATTESTATION_TOKEN / GV_SEND_RECAPTCHA_TOKEN  optional send tokens
 *   DEBUG=1                                 verbose logging of every event/filter
 */
import { Client } from "discord.js-selfbot-youtsuho-v13";
import { GoogleVoiceClient, loadEnv } from "google-voice-client";

/**
 * Workaround for a bug in discord.js-selfbot-youtsuho-v13: Util.getUploadURL
 * computes Discord's `file_size` from `file.byteLength ?? file.size`, but the
 * file objects it receives are MessagePayload wrappers whose actual bytes sit
 * at `file.file` — so it always sends `file_size: 0` and Discord rejects the
 * upload with "files[0].file_size: int value should be greater than or equal
 * to 1". Rebind getUploadURL to fall back to the inner bytes.
 */
// The fork's internal Util is CommonJS; `import * as` yields a frozen ESM
// namespace we can't rebind, so grab a mutable reference via CJS require.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Util = require("discord.js-selfbot-youtsuho-v13/src/util/Util") as {
  getUploadURL: (
    client: unknown,
    channelId: string,
    files: Array<{ file?: { byteLength?: number }; byteLength?: number; size?: number }>,
  ) => Promise<unknown>;
};
const origGetUploadURL = Util.getUploadURL.bind(Util);
Util.getUploadURL = async (
  client: unknown,
  channelId: string,
  files: Array<{ file?: { byteLength?: number }; byteLength?: number; size?: number }>,
) => {
  const sized = files.map((f) => ({
    ...f,
    byteLength: f.file?.byteLength ?? f.byteLength ?? 0,
  }));
  return origGetUploadURL(client, channelId, sized);
};

interface BridgeConfig {
  discordToken: string;
  dmUserId: string;
  phoneNumber: string;
  threadId: string;
  sendTokens?: { attestationToken: string; recaptchaToken: string };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

/**
 * Normalizes a phone number to E.164 form using only its digits: strips any
 * leading `+`, spaces, or punctuation and re-adds a single `+`. Google Voice
 * returns numbers as `+<cc><number>` (e.g. `+14697590653`), so matching and
 * thread-id derivation must agree on one canonical form regardless of how
 * `BRIDGE_PHONE` was typed.
 */
function toE164(raw: string): string {
  return `+${raw.replace(/\D/g, "")}`;
}

/**
 * Whether two phone numbers refer to the same line. Compares on digits only
 * and tolerates a missing/inconsistent country code: `4697590653` (national)
 * matches `+14697590653` (E.164 with US `1`) because one is a suffix of the
 * other. Google Voice returns the E.164 form, while `.env` may hold either.
 */
function numbersMatch(have: string, want: string): boolean {
  const a = have.replace(/\D/g, "");
  const b = want.replace(/\D/g, "");
  return a === b || a.endsWith(b) || b.endsWith(a);
}

function loadConfig(): BridgeConfig {
  const phoneNumber = toE164(env("BRIDGE_PHONE"));
  return {
    discordToken: env("DISCORD_TOKEN"),
    dmUserId: env("BRIDGE_DM_USER_ID"),
    phoneNumber,
    // Voice thread ids are "t.+<e164 digits>" — strip the + we added so the
    // literal format doesn't double up.
    threadId: `t.+${phoneNumber.replace(/^\+/, "")}`,
    sendTokens:
      process.env.GV_SEND_ATTESTATION_TOKEN && process.env.GV_SEND_RECAPTCHA_TOKEN
        ? {
            attestationToken: process.env.GV_SEND_ATTESTATION_TOKEN,
            recaptchaToken: process.env.GV_SEND_RECAPTCHA_TOKEN,
          }
        : undefined,
  };
}

const voiceEnv = loadEnv();
const config = loadConfig();
const voice = new GoogleVoiceClient(voiceEnv);
const discord = new Client();

/**
 * Debug logger: enabled when `DEBUG=1` (or `DEBUG=true`) is set in env.
 * Prints every Voice event and Discord filter decision so a bridge that
 * isn't relaying can be diagnosed.
 */
const debug = (...args: unknown[]): void => {
  if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
    console.log("[debug]", ...args);
  }
};

function stripLeadingMention(content: string): string {
  // A bridged user replying to our forwarded message quotes it with a
  // <@...> prefix — drop it so we don't echo the pinging mention to the phone.
  return content.replace(/^<@!?\d+>\s*/, "").trim();
}

/**
 * Downloads a Discord CDN attachment's bytes for forwarding as an MMS photo.
 * Selfbot message.attachments expose a public `url`; a plain fetch gets the
 * bytes. Returns the shape the Voice client's `attachment` option expects.
 */
async function fetchDiscordAttachment(
  url: string,
  contentType: string | null,
): Promise<{ data: Uint8Array; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download Discord attachment: ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  return { data, mimeType: contentType || "application/octet-stream" };
}

discord.once("ready", async () => {
  console.log(`Selfbot online as ${discord.user?.username}`);
  await voice.start({ intervalMs: 5000 });
  console.log("Voice poll loop started. Bridging", config.phoneNumber, "<->", config.dmUserId);
  if (!config.sendTokens) {
    console.warn(
      "GV_SEND_ATTESTATION_TOKEN / GV_SEND_RECAPTCHA_TOKEN not set — Discord→phone " +
        "sends will be skipped (Voice inbound to Discord still works).",
    );
  }
});

// Voice → Discord: forward incoming SMS/MMS from the bridged number into the
// DM you share with the bridged user.
voice.on("messageCreate", async (event) => {
  debug("voice messageCreate:", {
    direction: event.direction,
    otherParty: event.otherPartyNumber,
    wantParty: config.phoneNumber,
    text: (event.text || "").slice(0, 80),
    hasAttachment: event.attachments.length > 0,
  });
  if (event.direction !== "RECEIVED") {
    debug("→ skip: direction is", event.direction, "not RECEIVED");
    return;
  }
  if (!numbersMatch(event.otherPartyNumber, config.phoneNumber)) {
    debug("→ skip: otherParty", event.otherPartyNumber, "does not match bridged", config.phoneNumber);
    return;
  }
  try {
    const user = await discord.users.fetch(config.dmUserId);
    const dm = await user.createDM();
    const body = event.text || "(message with no text)";
    const attachment = event.attachments[0];
    if (attachment) {
      const { data, contentType } = await voice.downloadAttachment(attachment.id);
      const name = `attachment.${contentType.split("/")[1] ?? "bin"}`;
      debug("forwarding attachment to discord:", name, contentType, data.byteLength, "bytes");
      await dm.send({ content: body, files: [{ attachment: Buffer.from(data), name }] });
    } else {
      debug("forwarding text to discord:", JSON.stringify(body));
      await dm.send(body);
    }
    console.log(`[voice→discord] ${event.text || "<attachment>"}`);
  } catch (err) {
    console.error("[voice→discord] failed:", err instanceof Error ? err.message : err);
  }
});

// Voice auth failure — surfacing it beats silent message loss.
voice.on("disconnect", (error) => {
  console.error("[voice] disconnected:", error.message);
  console.error("Refresh the session cookie (.env) and restart.");
});

// Discord → Voice: forward a DM from the bridged user to the phone.
// Must ignore the selfbot's OWN messages (including its voice forwards),
// else we'd echo every forward back to the phone in a loop.
discord.on("messageCreate", async (message) => {
  debug("discord messageCreate:", {
    author: message.author?.id,
    self: discord.user?.id,
    channelType: message.channel?.type,
    content: (message.content || "").slice(0, 80),
  });
  if (message.author.id === discord.user?.id) {
    debug("→ skip: own message (would loop)");
    return;
  }
  if (message.author.id !== config.dmUserId) {
    debug("→ skip: author", message.author.id, "!= bridged", config.dmUserId);
    return;
  }
  if (message.channel.type !== "DM" && message.channel.type !== "GROUP") {
    debug("→ skip: not a DM channel (type", message.channel.type, ")");
    return;
  }
  if (!config.sendTokens) {
    console.warn("Outbound send skipped: no send tokens configured.");
    return;
  }
  const text = stripLeadingMention(message.content);
  // Allow attachment-only messages: fetch the first Discord attachment's
  // bytes to send as an MMS photo alongside (or instead of) the text.
  const discordAttachment = message.attachments.first();
  if (!text && !discordAttachment) {
    debug("→ skip: empty content and no attachment");
    return;
  }
  try {
    const attachment = discordAttachment
      ? await fetchDiscordAttachment(discordAttachment.url, discordAttachment.contentType)
      : undefined;
    debug(
      "sending to phone:",
      config.threadId,
      JSON.stringify(text),
      attachment ? `+ MMS (${attachment.mimeType}, ${attachment.data.byteLength}b)` : "",
    );
    await voice.sendMessage(config.threadId, text, String(Date.now()), {
      tokens: config.sendTokens,
      attachment,
    });
    console.log(`[discord→voice] ${text || "<attachment>"}`);
  } catch (err) {
    console.error("[discord→voice] failed:", err instanceof Error ? err.message : err);
    // A 400 on sendsms (not 401) almost always means the WAA/reCAPTCHA send
    // tokens have gone stale — they're session-recent and expire in
    // minutes-to-hours. Re-capture a fresh pair rather than guessing.
    if (err instanceof Error && /400|INVALID_ARGUMENT/.test(err.message)) {
      console.error(
        "↳ the GV_SEND_* tokens look stale — run `bun run capture-tokens` and re-send a message to refresh them (inbound forwarding still works meanwhile).",
      );
    }
  }
});

process.on("SIGINT", () => {
  voice.stop();
  void discord.destroy();
  process.exit(0);
});

await discord.login(config.discordToken);
