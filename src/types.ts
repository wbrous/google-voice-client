/** Direction of a Google Voice SMS thread event, derived from the event's direction flag. */
export type MessageDirection = "SENT" | "RECEIVED";

/** One resolution variant of an attachment, e.g. thumbnail vs. full size. */
export interface AttachmentSize {
  /** Server-assigned size code (observed values 1-4; meaning otherwise undocumented). */
  code: number;
  width: number;
  height: number;
}

/**
 * One MMS attachment on a thread event, as embedded in `api2thread/list`'s
 * response (no separate network call is needed to discover it — only to
 * fetch its actual bytes, via {@link GoogleVoiceClient.downloadAttachment}).
 */
export interface Attachment {
  /** MIME type as reported by the server, e.g. `"image/jpeg"`. */
  mimeType: string;
  /** Attachment id, used with {@link GoogleVoiceClient.downloadAttachment}. */
  id: string;
  /** Available resolution variants. */
  sizes: AttachmentSize[];
}

/**
 * One event row from `api2thread/list`, decoded from its positional array
 * form.
 */
export interface ThreadEvent {
  /** Opaque per-event id assigned by the server. */
  id: string;
  /** Event timestamp in epoch milliseconds. */
  timestampMs: number;
  /** The signed-in Google Voice number this thread belongs to. */
  accountNumber: string;
  /** The other party's phone number (E.164). */
  otherPartyNumber: string;
  /** Whether this event was an outgoing send or an incoming receive. */
  direction: MessageDirection;
  /** The SMS/MMS message body, verbatim; empty string for attachment-only messages. */
  text: string;
  /** MMS attachments on this event, if any. */
  attachments: Attachment[];
  /** Thread id, e.g. `"t.+14697590653"`. */
  threadId: string;
  /**
   * Client-generated temporary id echoed back for events this client sent
   * (via {@link GoogleVoiceClient.sendMessage}'s `tmpId`); `undefined` for
   * events received from elsewhere.
   */
  tmpId?: string;
}

/** A thread (conversation) and its events, as returned by `api2thread/list`. */
export interface Thread {
  /** Thread id, e.g. `"t.+14697590653"`. */
  threadId: string;
  /** Events in this thread, newest first (matching API order). */
  events: ThreadEvent[];
}
