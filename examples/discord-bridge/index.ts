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
 * The two directions are deliberately symmetric: a person on the phone and a
 * person on Discord both just see the other's plain messages (plus files).
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
 *   GV_POLL_INTERVAL_SEC                   Voice poll interval (default 5)
 *   DEBUG=1                                 verbose logging of every event/filter
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Client, type Message } from "discord.js-selfbot-youtsuho-v13";
import { GoogleVoiceClient, loadEnv } from "google-voice-client";

/**
 * Workaround for a bug in discord.js-selfbot-youtsuho-v13: Util.getUploadURL
 * computes Discord's `file_size` from `file.byteLength ?? file.size`, but the
 * file objects it receives are MessagePayload wrappers whose actual bytes sit
 * at `file.file` — so it always sends `file_size: 0` and Discord rejects the
 * upload with "files[0].file_size: int value should be greater than or equal
 * to 1". Rebind getUploadURL to fall back to the inner bytes.
 *
 * The fork's internal Util is CommonJS; `import * as` yields a frozen ESM
 * namespace we can't rebind, so grab a mutable reference via CJS require.
 */
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
  /** Resolved lazily/once from the live API (see resolveThreadId). */
  threadId?: string;
  /** Seconds between Voice poll cycles. Defaults to 5. */
  pollIntervalSec: number;
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

/** Path to the `.env` file `readSendTokens` re-reads on every send. */
const ENV_PATH = process.env.GV_ENV_PATH ?? ".env";

/**
 * Parses `GV_SEND_ATTESTATION_TOKEN`/`GV_SEND_RECAPTCHA_TOKEN` lines out of
 * a raw `.env` file's contents, matching the `NAME="value"` format
 * `writeEnvVar` (from the parent library) writes.
 */
function parseEnvTokens(contents: string): { attestationToken?: string; recaptchaToken?: string } {
  const result: { attestationToken?: string; recaptchaToken?: string } = {};
  for (const line of contents.split("\n")) {
    const match = /^(GV_SEND_ATTESTATION_TOKEN|GV_SEND_RECAPTCHA_TOKEN)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2].replace(/^"(.*)"$/, "$1");
    if (match[1] === "GV_SEND_ATTESTATION_TOKEN") result.attestationToken = value;
    else result.recaptchaToken = value;
  }
  return result;
}

/**
 * Reads the outbound WAA/reCAPTCHA send-token pair fresh on every call
 * instead of once at startup. In the Docker Compose split, a sidecar
 * service (`bin/refresh-tokens.ts --loop`) rewrites these into the shared
 * `.env` file every few minutes; bun's `--env-file` only populates
 * `process.env` once at process start, so trusting `process.env` here would
 * silently serve stale (soon-expired) tokens for the bridge's entire
 * lifetime instead of picking up each refresh.
 *
 * @precondition None.
 * @postcondition Returns the freshest token pair found in {@link ENV_PATH},
 *   falling back to `process.env` (the boot-time value) if the file is
 *   missing or doesn't have both — e.g. under `bun test` or a single-shot
 *   deployment that never runs the refresh sidecar. Returns undefined if
 *   neither source has a complete pair.
 */
function readSendTokens(): { attestationToken: string; recaptchaToken: string } | undefined {
  const fromFile = existsSync(ENV_PATH) ? parseEnvTokens(readFileSync(ENV_PATH, "utf8")) : {};
  const attestationToken = fromFile.attestationToken ?? process.env.GV_SEND_ATTESTATION_TOKEN;
  const recaptchaToken = fromFile.recaptchaToken ?? process.env.GV_SEND_RECAPTCHA_TOKEN;
  return attestationToken && recaptchaToken ? { attestationToken, recaptchaToken } : undefined;
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
    pollIntervalSec: Number(process.env.GV_POLL_INTERVAL_SEC ?? 5),
  };
}

const voiceEnv = loadEnv();
const config = loadConfig();
const voice = new GoogleVoiceClient(voiceEnv);
const discord = new Client();

/**
 * Resolves the Voice thread id for the bridged phone by querying the live
 * account, rather than guessing "t.+<digits>" (which silently drops the
 * country code — the real thread is t.+14697590653, not t.+4697590653, and
 * sendsms returns INVALID_ARGUMENT for a wrong thread). Matches the other
 * party with the same suffix-tolerant numbersMatch used elsewhere, then
 * caches it so we only hit listThreads once per conversation.
 */
async function resolveThreadId(): Promise<string> {
  if (config.threadId) return config.threadId;
  const threads = await voice.listThreads();
  const match = threads.find((t) =>
    t.events.some((e) => numbersMatch(e.otherPartyNumber, config.phoneNumber)),
  );
  if (!match) {
    throw new Error(
      `No Voice thread found for ${config.phoneNumber}. Open a conversation with it in voice.google.com first, or check BRIDGE_PHONE.`,
    );
  }
  config.threadId = match.threadId;
  debug("resolved threadId:", config.threadId, "for", config.phoneNumber);
  return config.threadId;
}

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

/** Maps Google Voice's plain-label reaction verbs to a Discord emoji. */
const REACTION_LABEL_EMOJI: Record<string, string> = {
  Liked: "👍",
  Loved: "💖",
  Disliked: "👎",
};

/**
 * Parses one of Google Voice's iMessage-style "tapback" notification texts:
 * `Liked "…"`, `Loved "…"`, `Disliked "…"`, or `Reacted <emoji> to "…"`. The
 * quoted part may span multiple lines. Returns the emoji to react with and
 * the quoted text it targets, or `null` if `text` isn't one of these.
 */
function parseReactionMessage(text: string): { emoji: string; quoted: string } | null {
  const quoted = `[“"]([\\s\\S]*)[”"]`;
  const labelMatch = text.match(new RegExp(`^(Liked|Loved|Disliked) ${quoted}$`));
  if (labelMatch) {
    const [, label, body] = labelMatch;
    return { emoji: REACTION_LABEL_EMOJI[label as keyof typeof REACTION_LABEL_EMOJI], quoted: body };
  }
  const reactedMatch = text.match(new RegExp(`^Reacted (\\S+) to ${quoted}$`));
  if (reactedMatch) {
    const [, emoji, body] = reactedMatch;
    return { emoji, quoted: body };
  }
  return null;
}

/**
 * Bounded history of messages this bridge forwarded from Voice to Discord,
 * keyed by their exact text, so a later reaction notification (`Liked
 * "…"`) can be mapped onto the original Discord message instead of being
 * posted as its own message.
 */
const MAX_RECENT_FORWARDED = 50;
const recentForwarded: Array<{ text: string; message: Message }> = [];

function rememberForwarded(text: string, message: Message): void {
  recentForwarded.push({ text, message });
  if (recentForwarded.length > MAX_RECENT_FORWARDED) recentForwarded.shift();
}

function findForwardedMessage(text: string): Message | undefined {
  const normalized = text.trim();
  for (let i = recentForwarded.length - 1; i >= 0; i--) {
    if (recentForwarded[i].text.trim() === normalized) return recentForwarded[i].message;
  }
  return undefined;
}

function latestForwarded(): Message | undefined {
  return recentForwarded[recentForwarded.length - 1]?.message;
}

function updateRememberedText(message: Message, newText: string): void {
  for (let i = recentForwarded.length - 1; i >= 0; i--) {
    if (recentForwarded[i].message.id === message.id) {
      recentForwarded[i].text = newText;
      return;
    }
  }
}

/**
 * Parses a `.reply`/`.edit` command typed into the Messages app to control
 * the bridged Discord conversation from the phone side:
 *   .reply "quoted target text"
 *   the reply body (rest of the message)
 * or, omitting the quoted target to act on the most recently forwarded
 * message in either direction:
 *   .reply
 *   the reply body
 * `.edit` works the same way but edits the target message's content instead
 * of replying to it (only succeeds if the bridge itself sent that message —
 * Discord only allows editing your own messages). Returns `null` for
 * anything that isn't a well-formed command (wrong command name, or no
 * payload line after the command).
 */
function parseVoiceCommand(text: string): { type: "reply" | "edit"; quoted?: string; body: string } | null {
  const newlineIndex = text.indexOf("\n");
  if (newlineIndex === -1) return null;
  const firstLine = text.slice(0, newlineIndex);
  const body = text.slice(newlineIndex + 1).trim();
  const match = firstLine.match(/^\.(reply|edit)(?:\s+"([^"]*)")?\s*$/i);
  if (!match || !body) return null;
  return { type: match[1].toLowerCase() as "reply" | "edit", quoted: match[2]?.trim(), body };
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

/**
 * If `message` is a Discord reply, fetches the message it replied to and
 * formats it as a block quote (every line prefixed with `> `), matching the
 * iMessage/SMS-style quoting Google Voice shows in the Messages app:
 *   > original line one
 *   > original line two
 *
 * Returns `undefined` for a non-reply, or if the referenced message can no
 * longer be fetched (e.g. it was deleted).
 */
async function buildReplyQuote(message: Message): Promise<string | undefined> {
  const referenceId = message.reference?.messageId;
  if (!referenceId) return undefined;
  try {
    const referenced = await message.channel.messages.fetch(referenceId);
    const quotedText = referenced.content || "(no text)";
    return quotedText
      .split("\n")
      .map((line: string) => `> ${line}`)
      .join("\n");
  } catch (err) {
    debug("failed to fetch replied-to message:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

discord.once("ready", async () => {
  console.log(`Selfbot online as ${discord.user?.username}`);
  await voice.start({ intervalMs: config.pollIntervalSec * 1000 });
  console.log("Voice poll loop started. Bridging", config.phoneNumber, "<->", config.dmUserId);
  if (!readSendTokens()) {
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
    if (!attachment) {
      const command = parseVoiceCommand(body);
      if (command) {
        const target = command.quoted ? findForwardedMessage(command.quoted) : latestForwarded();
        if (target) {
          const label = (command.quoted ?? "<latest>").slice(0, 40);
          if (command.type === "reply") {
            const sent = await target.reply(command.body);
            rememberForwarded(command.body, sent);
            console.log(`[voice→discord] replied to "${label}"`);
          } else {
            await target.edit(command.body);
            updateRememberedText(target, command.body);
            console.log(`[voice→discord] edited "${label}"`);
          }
          return;
        }
        debug("command target not found among recent forwarded messages, sending as plain text");
      }
      const reaction = parseReactionMessage(body);
      if (reaction) {
        const target = findForwardedMessage(reaction.quoted);
        if (target) {
          debug("mapping voice reaction to discord react:", reaction.emoji, "on", JSON.stringify(reaction.quoted).slice(0, 80));
          await target.react(reaction.emoji);
          console.log(`[voice→discord] reacted ${reaction.emoji} to "${reaction.quoted.slice(0, 40)}"`);
          return;
        }
        debug("reaction target not found among recent forwarded messages, sending as plain text");
      }
    }
    if (attachment) {
      const { data, contentType } = await voice.downloadAttachment(attachment.id);
      const name = `attachment.${contentType.split("/")[1] ?? "bin"}`;
      debug("forwarding attachment to discord:", name, contentType, data.byteLength, "bytes");
      await dm.send({ content: body, files: [{ attachment: Buffer.from(data), name }] });
    } else {
      debug("forwarding text to discord:", JSON.stringify(body));
      const sent = await dm.send(body);
      rememberForwarded(body, sent);
    }
    console.log(`[voice→discord] ${event.text || "<attachment>"}`);
  } catch (err) {
    console.error("[voice→discord] failed:", err instanceof Error ? err.message : err);
  }
});

// Transient poll failures (e.g. a 503 blip) are retried automatically by
// the client and don't stop the loop — surface them only under DEBUG so a
// flaky network doesn't spam the console.
voice.on("pollError", (error, consecutiveFailures) => {
  debug("voice pollError:", error.message, `(${consecutiveFailures} in a row)`);
});

// The poll loop gives up after either a fatal auth error (401/403 — the
// session cookie is stale) or too many transient failures in a row. Rather
// than hang with a dead poll loop until someone notices and manually
// restarts, exit non-zero so a process supervisor (Docker `restart:
// unless-stopped`, systemd `Restart=on-failure`, etc.) restarts the bridge.
// Note: this does NOT refresh GV_COOKIE by itself — a genuinely expired
// session cookie needs a real login (see the main repo's browser/firefox
// cookie readers or a fresh manual capture) before a restart can recover.
voice.on("disconnect", (error) => {
  console.error("[voice] disconnected:", error.message);
  console.error("[voice] exiting so a process supervisor can restart the bridge.");
  try {
    void Promise.resolve(discord.destroy()).catch(() => {});
  } catch {
    // ignore — see the SIGINT handler's comment on this same call
  }
  process.exit(1);
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
  const sendTokens = readSendTokens();
  if (!sendTokens) {
    console.warn("Outbound send skipped: no send tokens configured.");
    return;
  }
  const rawText = stripLeadingMention(message.content);
  const replyQuote = await buildReplyQuote(message);
  const text = replyQuote ? `${replyQuote}\n\n${rawText}` : rawText;
  // Allow attachment-only messages: fetch the first Discord attachment's
  // bytes to send as an MMS photo alongside (or instead of) the text.
  const discordAttachment = message.attachments.first();
  if (!rawText && !discordAttachment && !replyQuote) {
    debug("→ skip: empty content and no attachment");
    return;
  }
  try {
    const attachment = discordAttachment
      ? await fetchDiscordAttachment(discordAttachment.url, discordAttachment.contentType)
      : undefined;
    const threadId = await resolveThreadId();
    debug(
      "sending to phone:",
      threadId,
      JSON.stringify(text),
      attachment ? `+ MMS (${attachment.mimeType}, ${attachment.data.byteLength}b)` : "",
    );
    await voice.sendMessage(threadId, text, String(Date.now()), {
      tokens: sendTokens,
      attachment,
      compress: true,
    });
    if (text) rememberForwarded(text, message);
    console.log(`[discord→voice] ${text || "<attachment>"}`);
  } catch (err) {
    console.error("[discord→voice] failed:", err instanceof Error ? err.message : err);
    // A 400 INVALID_ARGUMENT on sendsms is usually a stale
    // WAA/reCAPTCHA send-token (they expire in minutes-hours) OR a wrong
    // threadId. Point at both so the operator can re-capture tokens or
    // confirm the resolved thread.
    if (err instanceof Error && /400|INVALID_ARGUMENT/.test(err.message)) {
      console.error(
        "↳ likely a stale GV_SEND_* token (`bun run capture-tokens`) or a wrong threadId — the debug line above shows the thread being used.",
      );
    }
  }
});

process.on("SIGINT", () => {
  voice.stop();
  // discord.js-selfbot-youtsuho-v13's WebSocketShard#destroy() dereferences
  // `this.connection` unconditionally; if the gateway connection was never
  // established (or already dropped) that throws a synchronous TypeError
  // that would otherwise surface as an uncaught exception during shutdown.
  try {
    void Promise.resolve(discord.destroy()).catch(() => {});
  } catch {
    // ignore — see comment above
  }
  process.exit(0);
});

await discord.login(config.discordToken);
