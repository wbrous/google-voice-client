import type { Thread, ThreadEvent } from "./types";

/**
 * Decodes one raw event row from `api2thread/list`'s positional array
 * response into a {@link ThreadEvent}.
 *
 * Row shape (0-indexed, reverse-engineered from live captures):
 * `[id, timestampMs, accountNumber, participants, typeCode, directionFlag,
 *   _, _, _, text, _, _, _, _, _, otherPartyNumber, _, tmpId, ...tail,
 *   threadId]`, where `directionFlag` is `0` for a received message and `1`
 * for one this account sent, and `text` is the SMS body verbatim (e.g. a
 * message whose body is literally "hello" appears as `row[9] === "hello"`).
 *
 * @precondition `row` is a raw array from a thread's event list, containing
 *   at least 30 elements with `row[5]` set to `0` or `1`.
 * @postcondition Returns the decoded event; throws if `row[5]` isn't `0` or
 *   `1`, since that indicates the wire format changed.
 */
export function parseThreadEvent(row: unknown[]): ThreadEvent {
  const directionFlag = row[5];
  if (directionFlag !== 0 && directionFlag !== 1) {
    throw new Error(`Unrecognized thread event direction flag: ${JSON.stringify(directionFlag)}`);
  }
  return {
    id: String(row[0]),
    timestampMs: Number(row[1]),
    accountNumber: String(row[2]),
    otherPartyNumber: String(row[15]),
    direction: directionFlag === 1 ? "SENT" : "RECEIVED",
    text: String(row[9]),
    threadId: String(row[row.length - 1]),
    tmpId: row[17] == null ? undefined : String(row[17]),
  };
}

/**
 * Decodes the full JSON body of an `api2thread/list` response into
 * {@link Thread}s.
 *
 * @precondition `body` is the parsed `protojson` response: `[threads, ...]`
 *   where `threads` is `[[threadId, _, events], ...]`.
 * @postcondition Returns one {@link Thread} per entry, in response order.
 */
export function parseThreadListResponse(body: unknown): Thread[] {
  const threads = (body as unknown[])[0] as unknown[];
  return threads.map((t) => {
    const [threadId, , events] = t as [string, unknown, unknown[][]];
    return {
      threadId,
      events: events.map(parseThreadEvent),
    };
  });
}
