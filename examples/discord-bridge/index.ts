/**
 * Bridge between one Google Voice phone number and one Discord DM.
 *
 * Two-way:
 * - **Voice → Discord**: a message received on the configured phone number
 *   is forwarded into the DM channel you share with the bot.
 * - **Discord → Voice**: a message you send in that DM is delivered to the
 *   phone number.
 *
 * Outbound (Discord → Voice) sends require the anti-abuse tokens Google's
 * web client mints via its WAA/BotGuard + reCAPTCHA flow (the SDK cannot
 * mint them). Set `GV_SEND_ATTESTATION_TOKEN` and `GV_SEND_RECAPTCHA_TOKEN`
 * to replay a freshly-captured pair. Inbound forwarding needs only the
 * session cookie.
 *
 * Environment:
 *   GV_COOKIE / GV_API_KEY / GV_SAPISID ...  Google Voice session (see .env)
 *   DISCORD_TOKEN                          Discord bot token
 *   BRIDGE_DM_USER_ID                      Discord user whose DM is bridged
 *   BRIDGE_PHONE                           E.164 phone (e.g. +14697590653)
 *   GV_SEND_ATTESTATION_TOKEN              optional: WAA/BotGuard token
 *   GV_SEND_RECAPTCHA_TOKEN                optional: reCAPTCHA-style token
 *   VOICE_API_KEY                          override GV_API_KEY if different
 */
import { Client as DiscordClient, Events, GatewayIntentBits } from "discord.js";
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
const discord = new DiscordClient({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
});

function stripLeadingMention(content: string): string {
  // Discord prefixes a bridged user's message with `<@id> ` when they reply
  // to the bot; drop it so we don't send "@bot text" to the phone.
  return content.replace(/^<@!?\d+>\s*/, "").trim();
}

discord.once(Events.ClientReady, async () => {
  console.log(`Discord bot online as ${discord.user?.tag}`);
  await voice.start({ intervalMs: 5000 });
  console.log("Voice poll loop started. Bridging", config.phoneNumber, "<->", config.dmUserId);
  if (!config.sendTokens) {
    console.warn(
      "GV_SEND_ATTESTATION_TOKEN / GV_SEND_RECAPTCHA_TOKEN not set — Discord→phone " +
        "sends will be skipped (Voice inbound to Discord still works).",
    );
  }
});

// Voice → Discord: forward incoming SMS/MMS from the bridged number.
voice.on("messageCreate", async (event) => {
  if (event.direction !== "RECEIVED") return; // ignore our own sends
  if (event.otherPartyNumber !== config.phoneNumber) return;
  try {
    const user = await discord.users.fetch(config.dmUserId);
    const dm = await user.createDM();
    let body = event.text || "(message with no text)";
    // Download the first attachment and send it with the caption.
    const attachment = event.attachments[0];
    if (attachment) {
      const { data, contentType } = await voice.downloadAttachment(attachment.id);
      const name = `attachment.${contentType.split("/")[1] ?? "bin"}`;
      await dm.send({ content: body, files: [{ attachment: Buffer.from(data), name }] });
    } else {
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

// Discord → Voice: forward the bridged user's DM to the phone.
discord.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.author.id !== config.dmUserId) return;
  if (!config.sendTokens) {
    console.warn("Outbound send skipped: no send tokens configured.");
    await message.channel
      .send("Cannot send: GV_SEND_ATTESTATION_TOKEN / GV_SEND_RECAPTCHA_TOKEN not set.")
      .catch(() => {});
    return;
  }
  const text = stripLeadingMention(message.content);
  try {
    await voice.sendMessage(config.threadId, text, String(Date.now()), {
      tokens: config.sendTokens,
    });
    console.log(`[discord→voice] ${text}`);
  } catch (err) {
    console.error("[discord→voice] failed:", err instanceof Error ? err.message : err);
    await message.channel
      .send(`Failed to send: ${err instanceof Error ? err.message : String(err)}`)
      .catch(() => {});
  }
});

process.on("SIGINT", () => {
  voice.stop();
  void discord.destroy();
  process.exit(0);
});

await discord.login(config.discordToken);
