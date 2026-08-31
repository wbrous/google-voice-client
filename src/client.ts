import { buildAuthorizationHeader } from "./auth";
import type { GoogleVoiceEnv } from "./env";
import { parseThreadListResponse } from "./parse";
import type { Thread } from "./types";

const API_ROOT = "https://clients6.google.com/voice/v1/voiceclient";
const PAGE_ORIGIN = "https://voice.google.com";
const REQUEST_ORIGIN = "https://clients6.google.com";

/**
 * Minimal client for Google Voice's internal (undocumented) web API,
 * authenticated by replaying a browser session's cookies rather than OAuth.
 *
 * @precondition Constructed with credentials from an active, authenticated
 *   voice.google.com session (see {@link loadEnv} / .env.example).
 */
export class GoogleVoiceClient {
  constructor(private readonly env: GoogleVoiceEnv) {}

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
   * account.
   *
   * Note: this endpoint returns event *metadata* only (who, when, thread,
   * send/receive) — Google Voice does not include message body text in this
   * response; see README for why.
   *
   * @precondition Client was constructed with valid, unexpired credentials.
   * @postcondition Resolves to every thread visible to the account; throws
   *   if the HTTP request fails or the response isn't valid JSON.
   */
  async listThreads(): Promise<Thread[]> {
    const res = await fetch(this.url("api2thread/list"), {
      method: "POST",
      headers: this.headers(),
      body: "[]",
    });
    if (!res.ok) {
      throw new Error(`api2thread/list failed: ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    return parseThreadListResponse(body);
  }

  /**
   * Sends a raw `SEND MESSAGE` request to a thread. This mirrors the exact
   * request Google Voice's web client issues, **except** for the message
   * body: Google Voice encodes the outgoing text into an opaque token
   * (captured requests show a single long non-standard-base64 string) whose
   * encoding could not be determined from a single network capture. Callers
   * must supply that pre-encoded `payload` themselves.
   *
   * @precondition `threadId` matches an existing thread (e.g.
   *   `"t.+15551234567"`); `tmpId` is a client-chosen unique numeric string
   *   used to correlate this send with its eventual event row; `payload` is
   *   a valid pre-encoded Google Voice message token.
   * @postcondition Resolves to the raw parsed JSON response on success;
   *   throws on a non-2xx HTTP response.
   */
  async sendRawMessage(threadId: string, tmpId: string, payload: string): Promise<unknown> {
    const body = JSON.stringify([
      null,
      null,
      null,
      null,
      "SEND MESSAGE",
      threadId,
      null,
      null,
      [Number(tmpId)],
      null,
      [payload],
    ]);
    const res = await fetch(this.url("api2thread/sendsms"), {
      method: "POST",
      headers: this.headers(new TextEncoder().encode(body).length),
      body,
    });
    if (!res.ok) {
      throw new Error(`api2thread/sendsms failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }
}
