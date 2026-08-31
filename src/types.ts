/** Direction of a Google Voice SMS thread event, as labeled by the API. */
export type MessageDirection = "SEND MESSAGE" | "RECEIVE MESSAGE";

/**
 * One event row from `api2thread/list`, decoded from its positional array
 * form. The endpoint does not return message body text (see README) — only
 * metadata: who, when, which thread, and whether it was sent or received.
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
  /** Thread id, e.g. `"t.+14697590653"`. */
  threadId: string;
  /**
   * Client-generated temporary id echoed back for events this client sent
   * (via {@link GoogleVoiceClient.sendRawMessage}'s `tmpId`); `undefined`
   * for events received from elsewhere.
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
