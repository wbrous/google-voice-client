/**
 * Selfbot bridge between one Google Voice phone number and one Discord DM.
 *
 * Logs in as YOUR OWN Discord user account (a "selfbot") and bridges the DM
 * you share with `BRIDGE_DM_USER_ID` to `BRIDGE_PHONE`:
 * - Voice → Discord: a message received on the phone is DM'd to the bridged
 *   user (attachments forwarded as files).
 * - Discord → Voice: a DM from the bridged user is delivered to the phone.
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

function loadConfig(): BridgeConfig {
  const phoneNumber = env("BRIDGE_PHONE");
  return {
    discordToken: env("DISCORD_TOKEN"),
    dmUserId: env("BRIDGE_DM_USER_ID"),
    phoneNumber,
    // Voice thread ids are "t.+<e164>" — stable for a phone conversation.
    threadId: `t.+${phoneNumber}`,
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
  if (event.otherPartyNumber !== config.phoneNumber) {
    debug("→ skip: otherParty", event.otherPartyNumber, "!= bridged", config.phoneNumber);
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
  if (!text) {
    debug("→ skip: empty content after stripping mention");
    return;
  }
  try {
    debug("sending to phone:", config.threadId, JSON.stringify(text));
    await voice.sendMessage(config.threadId, text, String(Date.now()), {
      tokens: config.sendTokens,
    });
    console.log(`[discord→voice] ${text}`);
  } catch (err) {
    console.error("[discord→voice] failed:", err instanceof Error ? err.message : err);
  }
});

process.on("SIGINT", () => {
  voice.stop();
  void discord.destroy();
  process.exit(0);
});

await discord.login(config.discordToken);
