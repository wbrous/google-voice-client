import { describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, computeSapisidHash } from "../src/auth";

// If this fails: the SAPISIDHASH digest formula (SHA1 of "ts origin sapisid")
// no longer matches Google's known scheme, breaking auth for every request.
describe("computeSapisidHash", () => {
  test("matches a precomputed SHA1(ts origin sapisid) vector", () => {
    // sha1("1000000000 https://voice.google.com abc123") precomputed via node:crypto.
    const hash = computeSapisidHash("abc123", "https://voice.google.com", 1000000000);
    expect(hash).toBe("1000000000_b15be9278da4013243f7a9f5e41405f570249bfd");
  });

  test("is deterministic for the same inputs", () => {
    const a = computeSapisidHash("abc123", "https://voice.google.com", 42);
    const b = computeSapisidHash("abc123", "https://voice.google.com", 42);
    expect(a).toBe(b);
  });

  test("changes when sapisid changes", () => {
    const a = computeSapisidHash("abc123", "https://voice.google.com", 42);
    const b = computeSapisidHash("xyz789", "https://voice.google.com", 42);
    expect(a).not.toBe(b);
  });
});

// If this fails: the Authorization header no longer has the three-hash shape
// Google Voice's web client sends, and the server will reject requests.
describe("buildAuthorizationHeader", () => {
  test("repeats the same hash under all three SAPISIDHASH labels", () => {
    const header = buildAuthorizationHeader("abc123", "https://voice.google.com", 42);
    const hash = computeSapisidHash("abc123", "https://voice.google.com", 42);
    expect(header).toBe(`SAPISIDHASH ${hash} SAPISID1PHASH ${hash} SAPISID3PHASH ${hash}`);
  });
});
