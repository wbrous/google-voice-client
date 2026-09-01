import { EventEmitter } from "node:events";
import { buildAuthorizationHeader } from "./auth";
import { compressImageToFit } from "./compress";
import type { GoogleVoiceEnv } from "./env";
import type { ClientEventMap, VoiceClientEvent } from "./events";
import { parseThreadListResponse } from "./parse";
import type { Thread, ThreadEvent } from "./types";

const API_ROOT = "https://clients6.google.com/voice/v1/voiceclient";
const PAGE_ORIGIN = "https://voice.google.com";
const REQUEST_ORIGIN = "https://clients6.google.com";

/** Attachment content-type code Google Voice's web client uses for photo MMS attachments. */
const ATTACHMENT_TYPE_PHOTO = 2;

/**
 * Default cap on outgoing attachment size (raw bytes, before base64).
 * A live capture showed an ~11 MB attachment rejected with
 * `INVALID_ARGUMENT` and a ~400 KB one succeed; the exact server-side
 * cutoff between those is unconfirmed, so this default is conservative.
 */
const DEFAULT_MAX_ATTACHMENT_BYTES = 1_000_000;

/** An outgoing MMS photo attachment. */
export interface OutgoingAttachment {
  /** Raw image bytes (any format `sharp` can decode, if compression is needed). */
  data: Uint8Array;
  /** MIME type of `data`, e.g. `"image/jpeg"`. Informational; the server appears to sniff content regardless. */
  mimeType: string;
}

export interface SendMessageOptions {
  /**
   * Anti-abuse tokens the real web client attaches to every send (WAA/
   * BotGuard attestation + a reCAPTCHA-style token). Neither is generated
   * by this client. Omitting them causes the server to reject the request
   * (401).
   */
  tokens?: { attestationToken: string; recaptchaToken: string };
  /** A single photo attachment to send alongside (or instead of) `text`. */
  attachment?: OutgoingAttachment;
  /**
   * When `attachment.data` exceeds `maxAttachmentBytes`, re-encode it as a
   * smaller/lower-quality JPEG instead of throwing. Default `false`.
   */
  compress?: boolean;
  /** Raw-byte cap for `attachment.data` before it's sent. Default 1,000,000. */
  maxAttachmentBytes?: number;
}

export interface StartOptions {
  /**
   * How often (ms) the poll loop re-fetches `listThreads()` to diff for new
   * messages. Default `5000`.
   */
  intervalMs?: number;
}

/**
 * Typed EventEmitter wrapper (discord.js-style) so `client.on(...)` gets
 * exact event payloads instead of `any`.
 */
export interface VoiceClient {
  on<K extends VoiceClientEvent>(event: K, listener: (...args: ClientEventMap[K]) => void): this;
  once<K extends VoiceClientEvent>(event: K, listener: (...args: ClientEventMap[K]) => void): this;
  off<K extends VoiceClientEvent>(event: K, listener: (...args: ClientEventMap[K]) => void): this;
  emit<K extends VoiceClientEvent>(event: K, ...args: ClientEventMap[K]): boolean;
  removeAllListeners(event?: VoiceClientEvent): this;
}

/**
 * Minimal client for Google Voice's internal (undocumented) web API,
 * authenticated by replaying a browser session's cookies rather than OAuth.
 *
 * Adds a discord.js-style event API on top of the raw HTTP methods. Since
 * Voice delivers SMS over HTTP polling (not a push websocket), new-message
 * discovery is a background poll loop started with {@link start}:
 *
 * ```ts
 * const client = new GoogleVoiceClient(loadEnv());
 * client.on("ready", () => console.log("connected"));
 * client.on("messageCreate", m => console.log(`New ${m.direction}: ${m.text}`));
 * await client.start();
 * ```
 *
 * @precondition Constructed with credentials from an active, authenticated
 *   voice.google.com session (see {@link loadEnv} / .env.example).
 */
export class GoogleVoiceClient extends EventEmitter implements VoiceClient {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private snapshot = new Map<string, ThreadEvent>();

  constructor(private readonly env: GoogleVoiceEnv) {
    super();
  }

  private headers(extraContentLength?: number): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json+protobuf",
      Cookie: this.env.cookie,
      Authorization: buildAuthorizationHeader(this.env.sapisid, PAGE_ORIGIN),
      "X-Goog-AuthUser": this.env.authUser,
      "X-Client-Version": this.env.clientVersion,
      "X-Origin": PAGE_ORIGIN,
      "X-Referer": PAGE_ORIGIN,
      "X-Requested-With": "XMLHttpRequest",
      "X-Goog-Encode-Response-If-Executable": "base64",
      Origin: REQUEST_ORIGIN,
    };
    if (extraContentLength !== undefined) {
      headers["Content-Length"] = String(extraContentLength);
    }
    return headers;
  }

  private url(path: string): string {
    return `${API_ROOT}/${path}?alt=protojson&key=${this.env.apiKey}`;
  }

  /**
   * Fetches every thread (conversation) and its events for the signed-in
   * account, including each event's plaintext message body and any MMS
   * attachments (metadata only — see {@link downloadAttachment} for bytes).
   *
   * @precondition Client was constructed with valid, unexpired credentials.
   * @postcondition Resolves to every thread visible to the account; throws
   *   if the HTTP request fails or the response isn't valid JSON.
   */
  async listThreads(): Promise<Thread[]> {
    // [threadType=2 (SMS), pageSize=100, unknown=50] — matches a real
    // captured request body; the server rejects an empty "[]" body with 400.
    const body = "[2,100,50]";
    const res = await fetch(this.url("api2thread/list"), {
      method: "POST",
      headers: this.headers(new TextEncoder().encode(body).length),
      body,
    });
    if (!res.ok) {
      throw new Error(`api2thread/list failed: ${res.status} ${res.statusText}`);
    }
    const responseBody = await res.json();
    return parseThreadListResponse(responseBody);
  }

  /**
   * Downloads the raw bytes of an MMS attachment (from {@link Attachment.id}).
   *
   * A live capture showed Google Voice serves attachments from
   * `voice.google.com` (not `clients6.google.com`) via a plain cookie-
   * authenticated `GET` — no `Authorization`/SAPISIDHASH header needed.
   *
   * @precondition `attachmentId` is an `Attachment.id` from a real event
   *   (already includes its `-N` suffix, e.g. `"<hash>-1"`).
   * @postcondition Resolves to the attachment's bytes and reported content
   *   type; throws on a non-2xx HTTP response.
   */
  async downloadAttachment(
    attachmentId: string,
    sizeCode = 3,
  ): Promise<{ data: Uint8Array; contentType: string }> {
    const url = `${PAGE_ORIGIN}/u/${this.env.authUser}/a/i/${attachmentId}?s=${sizeCode}`;
    const res = await fetch(url, { headers: { Cookie: this.env.cookie } });
    if (!res.ok) {
      throw new Error(`downloadAttachment failed: ${res.status} ${res.statusText}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return { data, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  /**
   * Sends an SMS/MMS to a thread. `text` is the plain message body — Google
   * Voice's send request carries it verbatim (index 4 of the request
   * array). Pass `options.attachment` to send a photo.
   *
   * Emits `messageSend(threadId, text)` synchronously on success, so callers
   * can observe their own sends without waiting for the next poll tick.
   *
   * The real web client also attaches two anti-abuse tokens to every send
   * (see {@link SendMessageOptions.tokens}); omit them and the server
   * rejects with 401.
   *
   * @precondition `threadId` matches an existing thread (e.g.
   *   `"t.+15551234567"`); `tmpId` is a client-chosen unique numeric string
   *   used to correlate this send with its eventual event row.
   * @postcondition Resolves to the raw parsed JSON response on success;
   *   throws on a non-2xx HTTP response, or if the attachment is too large
   *   and `options.compress` isn't set (or compression still can't fit it).
   */
  async sendMessage(
    threadId: string,
    text: string,
    tmpId: string,
    options: SendMessageOptions = {},
  ): Promise<unknown> {
    const { tokens, attachment, compress = false, maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES } =
      options;

    let mediaField: [number, string] | null = null;
    if (attachment) {
      let { data } = attachment;
      if (data.byteLength > maxAttachmentBytes) {
        if (!compress) {
          throw new Error(
            `Attachment is ${data.byteLength} bytes, over the ${maxAttachmentBytes}-byte limit. ` +
              `Pass { compress: true } to automatically re-encode it, or shrink it yourself.`,
          );
        }
        ({ data } = await compressImageToFit(data, maxAttachmentBytes));
      }
      mediaField = [ATTACHMENT_TYPE_PHOTO, Buffer.from(data).toString("base64")];
    }

    const body = JSON.stringify([
      null,
      null,
      null,
      null,
      text,
      threadId,
      null,
      null,
      [Number(tmpId)],
      mediaField,
      tokens == null ? null : [tokens.attestationToken, null, null, tokens.recaptchaToken],
    ]);
    const res = await fetch(this.url("api2thread/sendsms"), {
      method: "POST",
      headers: this.headers(new TextEncoder().encode(body).length),
      body,
    });
    if (!res.ok) {
      throw new Error(`api2thread/sendsms failed: ${res.status} ${res.statusText}`);
    }
    const result = await res.json();
    this.emit("messageSend", threadId, text);
    return result;
  }

  /**
   * Starts the background poll loop (EventEmitter mode). Emits `ready` after
   * the first snapshot, then `messageCreate` / `messageUpdate` per poll tick
   * as the thread-cache differs from the previous one.
   *
   * @precondition Valid, unexpired credentials (see {@link GoogleVoiceEnv}).
   * @postcondition Poll timer running; `ready` emitted once the first
   *   snapshot lands.
   * @emits `ready` on startup; `messageCreate` / `messageUpdate` on diffs;
   *   `disconnect` on a poll error (stops the loop).
   */
  async start(options: StartOptions = {}): Promise<void> {
    if (this.pollTimer) return;
    const intervalMs = options.intervalMs ?? 5000;

    const tick = async (): Promise<void> => {
      let threads: Thread[];
      try {
        threads = await this.listThreads();
      } catch (error) {
        this.stop();
        this.emit("disconnect", error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const next = new Map<string, ThreadEvent>();
      for (const t of threads) {
        for (const event of t.events) {
          next.set(event.id, event);
        }
      }
      if (this.snapshot.size === 0) {
        this.snapshot = next;
        this.emit("ready", threads.length);
        return;
      }
      for (const [id, event] of next) {
        const before = this.snapshot.get(id);
        if (!before) {
          this.emit("messageCreate", event);
        } else if (JSON.stringify(before) !== JSON.stringify(event)) {
          this.emit("messageUpdate", event, before);
        }
      }
      this.snapshot = next;
    };

    this.pollTimer = setInterval(() => void tick(), intervalMs);
    // Unref so the event loop doesn't keep the process alive solely for polling.
    this.pollTimer.unref?.();
    await tick();
  }

  /** Stops the background poll loop. Emits nothing further. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Whether the poll loop is currently running. */
  get polling(): boolean {
    return this.pollTimer !== null;
  }
}
