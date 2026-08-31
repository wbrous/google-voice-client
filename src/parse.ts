import type { MessageDirection, Thread, ThreadEvent } from "./types";

/**
 * Decodes one raw event row from `api2thread/list`'s positional array
 * response into a {@link ThreadEvent}.
 *
 * Row shape (0-indexed, reverse-engineered from a live capture):
 * `[id, timestampMs, accountNumber, participants, typeCode, directionFlag,
 *   _, _, _, label, _, _, _, _, _, otherPartyNumber, _, tmpId, ...tail,
 *   threadId]`.
 *
 * @precondition `row` is a raw array from a thread's event list, containing
 *   at least 30 elements with `row[9]` set to a known {@link MessageDirection}.
 * @postcondition Returns the decoded event; throws if `row[9]` is not a
 *   recognized direction label, since that indicates the wire format changed.
 */
export function parseThreadEvent(row: unknown[]): ThreadEvent {
  const direction = row[9];
  if (direction !== "SEND MESSAGE" && direction !== "RECEIVE MESSAGE") {
    throw new Error(`Unrecognized thread event direction: ${JSON.stringify(direction)}`);
  }
  return {
    id: String(row[0]),
    timestampMs: Number(row[1]),
    accountNumber: String(row[2]),
    otherPartyNumber: String(row[15]),
    direction: direction as MessageDirection,
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
