import type { Attachment, AttachmentSize, Thread, ThreadEvent } from "./types";

/**
 * Decodes one attachment entry from an MMS event's content array.
 *
 * Row shape (0-indexed, reverse-engineered from a live capture):
 * `[mimeType, id, _, sizes, _, _, _, _, downloadPath]`, where `sizes` is
 * `[[sizeCode, width, height], ...]` and `id` already includes its `-N`
 * suffix (e.g. `"<hash>-1"`), usable directly with
 * {@link GoogleVoiceClient.downloadAttachment}.
 *
 * @precondition `row` is one entry of an MMS content array's attachment list.
 * @postcondition Returns the decoded attachment.
 */
function parseAttachment(row: unknown[]): Attachment {
  // Images carry a [[sizeCode, width, height], ...] array here; other
  // attachment types (e.g. video/3gpp) carry null — treat as no variants.
  const rawSizes = row[3];
  const sizes = Array.isArray(rawSizes)
    ? (rawSizes as unknown[][]).map(
        ([code, width, height]): AttachmentSize => ({
          code: Number(code),
          width: Number(width),
          height: Number(height),
        }),
      )
    : [];
  return {
    mimeType: String(row[0]),
    id: String(row[1]),
    sizes,
  };
}

/**
 * Decodes one raw event row from `api2thread/list`'s positional array
 * response into a {@link ThreadEvent}.
 *
 * Row shape (0-indexed, reverse-engineered from live captures):
 * `[id, timestampMs, accountNumber, participants, typeCode, directionFlag,
 *   _, _, _, textOrLabel, _, _, _, _, mmsContent, otherPartyNumber, _,
 *   tmpId, ...tail, threadId]`, where `directionFlag` is `0` for a received
 * message and `1` for one this account sent.
 *
 * For a plain SMS, `row[9]` is the message body verbatim (e.g. `"hello"`)
 * and `row[14]` is `null`. For an MMS, `row[9]` is instead a fixed type
 * label (`"MMS Sent"` / `"MMS Received"`, not real content) and `row[14]`
 * holds `[caption, _, attachments, ...]`, where `caption` is the message
 * text (often `""`) and `attachments` is a list of raw attachment rows
 * (see {@link parseAttachment}).
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
  const mmsContent = row[14];
  let text: string;
  let attachments: Attachment[];
  if (mmsContent != null) {
    const [caption, , rawAttachments] = mmsContent as [string, unknown, unknown[][]];
    text = caption ?? "";
    attachments = (rawAttachments ?? []).map(parseAttachment);
  } else {
    text = typeof row[9] === "string" ? row[9] : "";
    attachments = [];
  }
  return {
    id: String(row[0]),
    timestampMs: Number(row[1]),
    accountNumber: String(row[2]),
    otherPartyNumber: String(row[15]),
    direction: directionFlag === 1 ? "SENT" : "RECEIVED",
    text,
    attachments,
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
