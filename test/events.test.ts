import { afterEach, describe, expect, test } from "bun:test";
import { GoogleVoiceClient } from "../src/client";
import type { GoogleVoiceEnv } from "../src/env";
import type { Thread, ThreadEvent } from "../src/types";

function fakeEnv(): GoogleVoiceEnv {
  return {
    cookie: "SID=abc; SAPISID=def",
    apiKey: "key",
    sapisid: "def",
    authUser: "0",
    clientVersion: "1",
  };
}

function makeEvent(id: string, text: string, threadId = "t.1"): ThreadEvent {
  return {
    id,
    timestampMs: 1,
    accountNumber: "+100",
    otherPartyNumber: "+200",
    direction: "RECEIVED",
    text,
    attachments: [],
    threadId,
  };
}

function makeThread(events: ThreadEvent[]): Thread {
  return { threadId: events[0]?.threadId ?? "t.1", events };
}

describe("GoogleVoiceClient event emitter", () => {
  afterEach(() => {
    // Ensure no lingering timers between tests.
    (globalThis as { __teardown?: () => void }).__teardown?.();
  });

  // If this fails: sendMessage no longer surfaces its own sends as an
  // event, so listeners can't observe outbound messages without polling.
  test("emits messageSend after a successful sendMessage", async () => {
    const client = new GoogleVoiceClient(fakeEnv());
    // Stub fetch so the HTTP call returns ok without touching the network.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("[]", { status: 200 })) as typeof fetch;
    const events: Array<[string, string]> = [];
    client.on("messageSend", (threadId, text) => events.push([threadId, text]));

    try {
      await client.sendMessage("t.1", "hi", "123");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(events).toEqual([["t.1", "hi"]]);
  });

  // If this fails: the typed on() overloads regress to the untyped
  // EventEmitter any, so consumers lose per-event payload types.
  test("exposes typed on/once/off and removeAllListeners", () => {
    const client = new GoogleVoiceClient(fakeEnv());
    const spy = () => {};
    client.on("ready", spy);
    client.once("messageSend", spy);
    expect(() => {
      client.off("ready", spy);
      client.removeAllListeners("ready");
    }).not.toThrow();
  });
});

describe("GoogleVoiceClient poll loop", () => {
  // If this fails: the poll loop's first snapshot emits `ready` but skips
  // `messageCreate` for already-existing events.
  test("emits ready on first tick and messageCreate for a new event on the next", async () => {
    const client = new GoogleVoiceClient(fakeEnv());
    let nth = 0;
    // Inject a controllable listThreads.
    (client as unknown as { listThreads: () => Promise<Thread[]> }).listThreads = async () => {
      nth += 1;
      if (nth === 1) return [makeThread([makeEvent("a", "first")])];
      return [makeThread([makeEvent("a", "first"), makeEvent("b", "new")])];
    };

    const readyCount: number[] = [];
    const created: string[] = [];
    client.on("ready", (n) => readyCount.push(n));
    client.on("messageCreate", (m) => created.push(m.text));
    client.on("messageUpdate", () => created.push("UPDATE"));

    // Start with a very short interval so the second tick fires quickly.
    await client.start({ intervalMs: 1 });
    expect(readyCount).toEqual([1]);
    expect(created).toEqual([]);

    // Let the interval tick once more, then stop.
    await new Promise((r) => setTimeout(r, 25));
    client.stop();
    expect(created).toEqual(["new"]);
  });

  // If this fails: messageUpdate isn't emitted when an existing event's
  // attributes change between snapshots.
  test("emits messageUpdate when an event's content changes", async () => {
    const client = new GoogleVoiceClient(fakeEnv());
    let nth = 0;
    (client as unknown as { listThreads: () => Promise<Thread[]> }).listThreads = async () => {
      nth += 1;
      const text = nth === 1 ? "before" : "after";
      return [makeThread([makeEvent("x", text)])];
    };

    let ready = false;
    const updates: Array<[string, string]> = [];
    client.on("ready", () => (ready = true));
    client.on("messageUpdate", (m, before) => updates.push([before.text, m.text]));

    await client.start({ intervalMs: 1 });
    expect(ready).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    client.stop();
    expect(updates).toEqual([["before", "after"]]);
  });

  // If this fails: a poll error (e.g. stale 401) doesn't stop the loop or
  // emit `disconnect`, so auth failures hang silently.
  test("emits disconnect and stops polling on a listThreads error", async () => {
    const client = new GoogleVoiceClient(fakeEnv());
    (client as unknown as { listThreads: () => Promise<Thread[]> }).listThreads = async () => {
      throw new Error("401 Unauthorized");
    };

    const errors: Error[] = [];
    client.on("disconnect", (e) => errors.push(e));

    await client.start({ intervalMs: 1 });
    // The first tick throws synchronously inside start, so start resolves
    // only after disconnect has fired and the timer is stopped.
    expect(client.polling).toBe(false);
    expect(errors[0]?.message).toContain("401");
  });

  // If this fails: start() can be called twice and spawn duplicate timers,
  // emitting ready multiple times.
  test("start is idempotent", async () => {
    const client = new GoogleVoiceClient(fakeEnv());
    let calls = 0;
    (client as unknown as { listThreads: () => Promise<Thread[]> }).listThreads = async () => {
      calls += 1;
      return [makeThread([])];
    };
    const raws: number[] = [];
    client.on("ready", (n) => raws.push(n));

    await client.start({ intervalMs: 1 });
    await client.start({ intervalMs: 1 });
    expect(client.polling).toBe(true);
    client.stop();
    expect(calls).toBe(1);
    expect(raws).toEqual([1]);
  });
});
