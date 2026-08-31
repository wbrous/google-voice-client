import { describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, computeSapisidHash } from "../src/auth";

// If this fails: the SAPISIDHASH digest formula (SHA1 of "ts sapisid origin",
// verified against a live, non-redacted Google Voice request) no longer
// matches, breaking auth for every request.
describe("computeSapisidHash", () => {
  test("matches a precomputed SHA1(ts sapisid origin) vector", () => {
    // sha1("1000000000 abc123 https://voice.google.com") precomputed via node:crypto.
    const hash = computeSapisidHash("abc123", "https://voice.google.com", 1000000000);
    expect(hash).toBe("1000000000_f4fdd00aa7818646e6b25fcebdeafb6144635451");
  });

  test("matches a real captured request's SAPISID + timestamp + origin", () => {
    // From a live, non-redacted curl capture of waa-pa.clients6.google.com/.../Waa/Create.
    const hash = computeSapisidHash(
      "-OYpY4DiU79TpFmu/ATMm_Bfq8qheVBI7p",
      "https://voice.google.com",
      1788213380,
    );
    expect(hash).toBe("1788213380_75a87bc08388c460fdf1d542c3c12bf8ccf89345");
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
