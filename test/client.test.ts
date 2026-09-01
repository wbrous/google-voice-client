import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GoogleVoiceClient, VoiceHttpError } from "../src/client";
import type { ClientEventMap } from "../src/events";
import type { GoogleVoiceEnv } from "../src/env";

const TEST_ENV: GoogleVoiceEnv = {
  cookie: "SID=test",
  apiKey: "test-key",
  sapisid: "test-sapisid",
  authUser: "0",
  clientVersion: "1",
};

// A minimal well-formed api2thread/list body: no threads.
const EMPTY_LIST_RESPONSE = [[]];

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Installs a fetch mock that returns each response in `responses`, in order, one per call. */
function mockFetchSequence(responses: Array<{ status: number; body?: unknown }>): void {
  let call = 0;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : "", {
      status: r.status,
      statusText: r.status === 200 ? "OK" : "Error",
    });
  }) as typeof fetch;
}

/** Resolves once `event` has fired `count` times, with each call's arguments. */
function collectEvents<K extends keyof ClientEventMap>(
  client: GoogleVoiceClient,
  event: K,
  count: number,
): Promise<Array<ClientEventMap[K]>> {
  const { promise, resolve } = Promise.withResolvers<Array<ClientEventMap[K]>>();
  const collected: Array<ClientEventMap[K]> = [];
  const handler = (...args: ClientEventMap[K]) => {
    collected.push(args);
    if (collected.length >= count) {
      client.off(event, handler);
      resolve(collected);
    }
  };
  client.on(event, handler);
  return promise;
}

// If this fails: a transient HTTP failure (e.g. a 503 blip) kills the poll
// loop instead of being retried on the next tick, forcing a manual restart
// for what should be a self-healing hiccup.
describe("GoogleVoiceClient poll loop resilience", () => {
  test("a single transient 503 does not stop the loop or emit disconnect", async () => {
    mockFetchSequence([
      { status: 503 },
      { status: 200, body: EMPTY_LIST_RESPONSE },
    ]);
    const client = new GoogleVoiceClient(TEST_ENV);
    let disconnected = false;
    client.on("disconnect", () => {
      disconnected = true;
    });
    const pollErrors = collectEvents(client, "pollError", 1);
    const ready = collectEvents(client, "ready", 1);

    await client.start({ intervalMs: 5, maxConsecutiveFailures: 5 });
    // The first tick (inside `start`) failed with 503.
    await pollErrors;
    expect(disconnected).toBe(false);
    expect(client.polling).toBe(true);

    // The next interval tick succeeds; wait for the deterministic "ready"
    // signal instead of guessing how long that takes.
    await ready;
    expect(disconnected).toBe(false);
    expect(client.polling).toBe(true);
    client.stop();
  });

  // If this fails: a 401 (genuinely stale/invalid session cookie) gets
  // retried instead of failing fast — retrying a dead cookie can never
  // succeed, so it should disconnect immediately rather than burn through
  // maxConsecutiveFailures first.
  test("a 401 stops the loop immediately, without waiting for maxConsecutiveFailures", async () => {
    mockFetchSequence([{ status: 401 }]);
    const client = new GoogleVoiceClient(TEST_ENV);
    let disconnectError: Error | undefined;
    client.on("disconnect", (error) => {
      disconnectError = error;
    });

    await client.start({ intervalMs: 5, maxConsecutiveFailures: 5 });
    expect(client.polling).toBe(false);
    expect(disconnectError).toBeInstanceOf(VoiceHttpError);
    expect((disconnectError as VoiceHttpError).status).toBe(401);
  });

  // If this fails: the loop either never gives up on a persistent outage
  // (hangs forever retrying) or gives up too early (killed by a couple of
  // isolated blips instead of a sustained failure).
  test("gives up and disconnects after maxConsecutiveFailures transient errors in a row", async () => {
    mockFetchSequence([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const client = new GoogleVoiceClient(TEST_ENV);
    const disconnect = collectEvents(client, "disconnect", 1);

    await client.start({ intervalMs: 5, maxConsecutiveFailures: 3 });
    const [disconnectArgs] = await disconnect;
    const [error] = disconnectArgs;

    expect(client.polling).toBe(false);
    expect(error).toBeInstanceOf(VoiceHttpError);
    expect((error as VoiceHttpError).status).toBe(503);
  });

  // If this fails: a successful tick after transient failures doesn't reset
  // the failure counter, so isolated blips spread far apart could eventually
  // accumulate and trigger a spurious disconnect.
  test("a successful tick resets the consecutive-failure counter", async () => {
    mockFetchSequence([
      { status: 503 },
      { status: 200, body: EMPTY_LIST_RESPONSE },
      { status: 503 },
      { status: 200, body: EMPTY_LIST_RESPONSE },
    ]);
    const client = new GoogleVoiceClient(TEST_ENV);
    const errors = collectEvents(client, "pollError", 2);

    await client.start({ intervalMs: 5, maxConsecutiveFailures: 2 });
    const collected = await errors;

    // Every recorded pollError should be count 1 (never reaching 2 in a
    // row, since a success resets it between each failure).
    expect(collected.every(([, count]) => count === 1)).toBe(true);
    client.stop();
  });
});
