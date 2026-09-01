import { describe, expect, test } from "bun:test";
import { parseThreadEvent, parseThreadListResponse } from "../src/parse";

// A real row shape captured from api2thread/list, trimmed of unused fields
// but keeping every index the parser reads. `smsText` fills row[9] (plain
// SMS body or MMS type label); `mmsContent` fills row[14] (MMS content
// array, null for plain SMS).
function rawRow(
  overrides: {
    directionFlag?: unknown;
    smsText?: string;
    mmsContent?: unknown;
    tmpId?: string | null;
  } = {},
): unknown[] {
  const row = new Array(30).fill(null);
  row[0] = "79be97674bea1ae1f0cc2bb88cd71a1bc30e12be";
  row[1] = 1788212496449;
  row[2] = "+12143027963";
  row[5] = overrides.directionFlag ?? 0;
  row[9] = overrides.smsText ?? "hello";
  row[14] = overrides.mmsContent ?? null;
  row[15] = "+14697590653";
  row[17] = overrides.tmpId ?? null;
  row[29] = "t.+14697590653";
  return row;
}

// A real MMS content shape captured from api2thread/list: [caption, _,
// attachments, participants, senderOrNull, recipients].
const MMS_CONTENT = [
  "",
  "",
  [
    [
      "image/jpeg",
      "88dbcddf77baa928351ff1f10e645d95745babda-1",
      1,
      [
        [1, 588, 1280],
        [4, 588, 1280],
        [3, 235, 512],
        [2, 59, 128],
      ],
      3,
      null,
      null,
      null,
      "/download/voice/mms/88dbcddf77baa928351ff1f10e645d95745babda-1",
    ],
  ],
  [["+14697590653", "+14697590653", null, null, null, null, 0]],
  "+14697590653",
  ["+14697590653"],
];

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
      attachments: [],
      threadId: "t.+14697590653",
      tmpId: undefined,
    });
  });

  test("decodes the message body verbatim, including text that looks like a keyword", () => {
    const event = parseThreadEvent(rawRow({ smsText: "SEND MESSAGE" }));
    expect(event.text).toBe("SEND MESSAGE");
  });

  test("carries a tmpId when present, for events this client sent", () => {
    const event = parseThreadEvent(
      rawRow({ directionFlag: 1, tmpId: "237249786866331", smsText: "hi there" }),
    );
    expect(event.direction).toBe("SENT");
    expect(event.tmpId).toBe("237249786866331");
  });

  // If this fails: an unrecognized direction flag is silently accepted
  // instead of surfacing that the API's wire format changed.
  test("throws on an unrecognized direction flag", () => {
    expect(() => parseThreadEvent(rawRow({ directionFlag: 2 }))).toThrow(/Unrecognized/);
  });

  // If this fails: MMS events are read from the wrong index (row[9], a
  // fixed "MMS Sent"/"MMS Received" label, instead of row[14]) and their
  // real attachment metadata (mime type, download id, size variants) or
  // caption is silently dropped or misread.
  test("decodes an MMS event's attachments from row[14], ignoring row[9]'s type label", () => {
    const event = parseThreadEvent(rawRow({ smsText: "MMS Received", mmsContent: MMS_CONTENT }));
    expect(event.text).toBe("");
    expect(event.attachments).toHaveLength(1);
    expect(event.attachments[0]).toEqual({
      mimeType: "image/jpeg",
      id: "88dbcddf77baa928351ff1f10e645d95745babda-1",
      sizes: [
        { code: 1, width: 588, height: 1280 },
        { code: 4, width: 588, height: 1280 },
        { code: 3, width: 235, height: 512 },
        { code: 2, width: 59, height: 128 },
      ],
    });
  });
  // If this fails: non-image attachments (e.g. video/3gpp, whose sizes
  // field is null on the wire) crash the parser instead of decoding with an
  // empty variants list.
  test("decodes a video attachment with null sizes", () => {
    const content = ["", "", [["video/3gpp", "b413c15b-1", 3, null, 2]], [], "", []];
    const event = parseThreadEvent(rawRow({ smsText: "MMS Received", mmsContent: content }));
    expect(event.attachments).toEqual([
      {
        mimeType: "video/3gpp",
        id: "b413c15b-1",
        sizes: [],
      },
    ]);
  });
});

// If this fails: the top-level [threads, ...] response shape is decoded
// incorrectly, dropping threads or their events.
describe("parseThreadListResponse", () => {
  test("decodes threads and their events from the wrapped response body", () => {
    const body = [
      [["t.+14697590653", 0, [rawRow(), rawRow({ directionFlag: 1, tmpId: "1", smsText: "hi" })]]],
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
