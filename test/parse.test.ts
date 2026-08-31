import { describe, expect, test } from "bun:test";
import { parseThreadEvent, parseThreadListResponse } from "../src/parse";

// A real row shape captured from api2thread/list, trimmed of unused fields
// but keeping every index the parser reads.
function rawRow(overrides: { directionFlag?: unknown; text?: string; tmpId?: string | null } = {}): unknown[] {
  const row = new Array(30).fill(null);
  row[0] = "79be97674bea1ae1f0cc2bb88cd71a1bc30e12be";
  row[1] = 1788212496449;
  row[2] = "+12143027963";
  row[5] = overrides.directionFlag ?? 0;
  row[9] = overrides.text ?? "hello";
  row[15] = "+14697590653";
  row[17] = overrides.tmpId ?? null;
  row[29] = "t.+14697590653";
  return row;
}

// If this fails: decoding a raw thread-event row silently reads the wrong
// array indices, mixing up who sent what, the message text, or which
// thread it belongs to.
describe("parseThreadEvent", () => {
  test("decodes id, timestamp, parties, text, direction, and thread id", () => {
    const event = parseThreadEvent(rawRow());
    expect(event).toEqual({
      id: "79be97674bea1ae1f0cc2bb88cd71a1bc30e12be",
      timestampMs: 1788212496449,
      accountNumber: "+12143027963",
      otherPartyNumber: "+14697590653",
      direction: "RECEIVED",
      text: "hello",
      threadId: "t.+14697590653",
      tmpId: undefined,
    });
  });

  test("decodes the message body verbatim, including text that looks like a keyword", () => {
    const event = parseThreadEvent(rawRow({ text: "SEND MESSAGE" }));
    expect(event.text).toBe("SEND MESSAGE");
  });

  test("carries a tmpId when present, for events this client sent", () => {
    const event = parseThreadEvent(
      rawRow({ directionFlag: 1, tmpId: "237249786866331", text: "hi there" }),
    );
    expect(event.direction).toBe("SENT");
    expect(event.tmpId).toBe("237249786866331");
  });

  // If this fails: an unrecognized direction flag is silently accepted
  // instead of surfacing that the API's wire format changed.
  test("throws on an unrecognized direction flag", () => {
    expect(() => parseThreadEvent(rawRow({ directionFlag: 2 }))).toThrow(/Unrecognized/);
  });
});

// If this fails: the top-level [threads, ...] response shape is decoded
// incorrectly, dropping threads or their events.
describe("parseThreadListResponse", () => {
  test("decodes threads and their events from the wrapped response body", () => {
    const body = [
      [["t.+14697590653", 0, [rawRow(), rawRow({ directionFlag: 1, tmpId: "1", text: "hi" })]]],
      "1",
      "v",
    ];
    const threads = parseThreadListResponse(body);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.threadId).toBe("t.+14697590653");
    expect(threads[0]!.events).toHaveLength(2);
    expect(threads[0]!.events[1]!.direction).toBe("SENT");
    expect(threads[0]!.events[1]!.text).toBe("hi");
  });
});
