import { describe, expect, test } from "bun:test";
import { extractCookieValue, loadEnv } from "../src/env";

// If this fails: cookie parsing breaks on real-world Cookie header formats
// (multiple cookies, values containing "=", missing target cookie).
describe("extractCookieValue", () => {
  test("finds a cookie by name among several", () => {
    const header = "AEC=abc; SAPISID=xyz123; NID=534=longvalue";
    expect(extractCookieValue(header, "SAPISID")).toBe("xyz123");
  });

  test("preserves '=' characters inside the value", () => {
    const header = "NID=534=long=value=with=equals";
    expect(extractCookieValue(header, "NID")).toBe("534=long=value=with=equals");
  });

  test("returns undefined when the cookie is absent", () => {
    expect(extractCookieValue("AEC=abc", "SAPISID")).toBeUndefined();
  });
});

// If this fails: loadEnv silently proceeds with missing/undetermined
// credentials instead of failing fast at startup.
describe("loadEnv", () => {
  const originalEnv = { ...process.env };

  function resetEnv() {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GV_")) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }

  test("throws when GV_COOKIE is missing", () => {
    resetEnv();
    delete process.env.GV_COOKIE;
    process.env.GV_API_KEY = "key";
    expect(() => loadEnv()).toThrow(/GV_COOKIE/);
    resetEnv();
  });

  test("derives sapisid from the SAPISID cookie inside GV_COOKIE", () => {
    resetEnv();
    process.env.GV_COOKIE = "AEC=abc; SAPISID=derived-value";
    process.env.GV_API_KEY = "key";
    delete process.env.GV_SAPISID;
    const env = loadEnv();
    expect(env.sapisid).toBe("derived-value");
    resetEnv();
  });

  test("throws when sapisid cannot be determined at all", () => {
    resetEnv();
    process.env.GV_COOKIE = "AEC=abc";
    process.env.GV_API_KEY = "key";
    delete process.env.GV_SAPISID;
    expect(() => loadEnv()).toThrow(/SAPISID/);
    resetEnv();
  });
});
