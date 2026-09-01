import type { EventEmitter } from "node:events";
import type { ThreadEvent } from "./types";

/**
 * Events emitted by {@link GoogleVoiceClient} (discord.js-style listeners
 * via `client.on("...", cb)`).
 *
 * Events are delivered from two sources:
 * - `messageCreate` / `messageUpdate` / `ready` / `disconnect` come from an
 *   internal polling loop that diffs `listThreads()` snapshots (Voice has no
 *   push channel for SMS, so discovery is HTTP-poll — see the client docs).
 * - `messageSend` is emitted synchronously from `sendMessage()` so callers
 *   can observe their own sends without waiting for the next poll tick.
 */
export interface ClientEventMap {
  /**
   * Emitted once the client's polling loop has fetched its first snapshot
   * and is ready to discover new messages.
   * @param threadsCount number of threads seen on the first snapshot.
   */
  ready: [threadsCount: number];
  /**
   * Emitted when a new message arrives that wasn't in the previous snapshot.
   * @param message the newly-seen event.
   */
  messageCreate: [message: ThreadEvent];
  /**
   * Emitted when a previously-seen message's attributes change between
   * snapshots (e.g. a `RECEIVED` read receipt flag changing).
   * @param message the updated event.
   * @param before the previous snapshot of the same event.
   */
  messageUpdate: [message: ThreadEvent, before: ThreadEvent];
  /**
   * Emitted when a poll tick fails (any HTTP or network error). The loop
   * keeps retrying on its normal interval unless the failure is a fatal
   * auth error (401/403) or `consecutiveFailures` reaches the configured
   * limit — in either case `disconnect` follows immediately after.
   * @param error the failure from this tick.
   * @param consecutiveFailures how many poll ticks have failed in a row,
   *   including this one. Resets to 0 on the next successful tick.
   */
  pollError: [error: Error, consecutiveFailures: number];
  /**
   * Emitted when the poll loop gives up: either a fatal auth error (401/403
   * — typically a stale session cookie, retrying won't help) or
   * `consecutiveFailures` transient errors in a row. The loop stops
   * polling; call {@link GoogleVoiceClient.start} to restart after
   * refreshing credentials.
   * @param error the failure that stopped the loop.
   */
  disconnect: [error: Error];
  /**
   * Emitted synchronously by `sendMessage()` when a message is sent.
   * @param threadId the thread the message went to.
   * @param text the message body sent.
   */
  messageSend: [threadId: string, text: string];
}

export type VoiceClientEvent = keyof ClientEventMap;
