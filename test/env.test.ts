import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { extractCookieValue, loadEnv, writeEnvCookie } from "../src/env";

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

// If this fails: writeEnvCookie corrupts an existing .env (dropping other
// lines or failing to replace the GV_COOKIE line), so a refreshed cookie
// would silently be ignored or a stale one kept.
describe("writeEnvCookie", () => {
  const envPath = "/tmp/gv-ws-env-test.env";

  beforeEach(() => rmSync(envPath, { force: true }));

  test("creates the GV_COOKIE line in a nonexistent file", () => {
    writeEnvCookie("A=B; C=D", envPath);
    expect(readFileSync(envPath, "utf8")).toBe('GV_COOKIE="A=B; C=D"\n');
  });

  test("replaces an existing GV_COOKIE line, preserving other lines", () => {
    writeFileSync(envPath, 'GV_API_KEY=key\nGV_COOKIE="oldvalue"\nGV_AUTH_USER=1\n');
    writeEnvCookie("newvalue", envPath);
    expect(readFileSync(envPath, "utf8")).toBe('GV_API_KEY=key\nGV_COOKIE="newvalue"\nGV_AUTH_USER=1\n');
  });

  test("appends GV_COOKIE when the file has no GV_COOKIE line yet", () => {
    writeFileSync(envPath, "GV_API_KEY=key\n");
    writeEnvCookie("value", envPath);
    expect(readFileSync(envPath, "utf8")).toBe('GV_API_KEY=key\nGV_COOKIE="value"\n');
  });

  test("round-trips a cookie containing characters that look like quotes is preserved verbatim", () => {
    writeEnvCookie("SAPISID=x-abc/123; SIDCC=zzz", envPath);
    const written = readFileSync(envPath, "utf8");
    expect(written).toContain('GV_COOKIE="SAPISID=x-abc/123; SIDCC=zzz"');
  });
});
