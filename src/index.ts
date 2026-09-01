/**
 * google-voice-ws entry point.
 *
 * @precondition None.
 * @postcondition Re-exports the public API of the library.
 */
export const VERSION = "0.1.0";

export { buildAuthorizationHeader, computeSapisidHash } from "./auth";
export { compressImageToFit } from "./compress";
export { GoogleVoiceClient } from "./client";
export type { OutgoingAttachment, SendMessageOptions } from "./client";
export { extractCookieValue, loadEnv, writeEnvCookie } from "./env";
export type { GoogleVoiceEnv } from "./env";
export { refreshCookies, refreshEnv } from "./refresh";
export type { RefreshCookiesOptions, RefreshedCookies } from "./refresh";
export { parseThreadEvent, parseThreadListResponse } from "./parse";
export type { Attachment, AttachmentSize, MessageDirection, Thread, ThreadEvent } from "./types";
