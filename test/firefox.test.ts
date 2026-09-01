import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { findBrowserProfileDir, parseProfilesIni, readFirefoxSession } from "../src/firefox";

// If this fails: profiles.ini parsing misreads section structure, pointing
// the reader at the wrong (or no) profile directory.
describe("parseProfilesIni", () => {
  test("extracts the install-default and Default=1 profile paths", () => {
    const ini = `[Profile1]
Name=Default Profile
IsRelative=1
Path=01zfztgz.Default Profile
Default=1

[Profile0]
Name=Default (release)
IsRelative=1
Path=bdgpnptr.Default (release)

[General]
StartWithLastProfile=1
Version=2

[Install15B76BAA26BA15E7]
Default=bdgpnptr.Default (release)
Locked=1
`;
    expect(parseProfilesIni(ini)).toEqual({
      installDefault: "bdgpnptr.Default (release)",
      flaggedDefault: "01zfztgz.Default Profile",
    });
  });

  test("returns undefined entries for a minimal ini", () => {
    expect(parseProfilesIni("[General]\nVersion=2\n")).toEqual({
      installDefault: undefined,
      flaggedDefault: undefined,
    });
  });

  test("resolves absolute Path values untouched", () => {
    const ini = `[Profile7]\nPath=/abs/dir\nIsRelative=0\nDefault=1\n`;
    expect(parseProfilesIni(ini).flaggedDefault).toBe("/abs/dir");
  });
});

// If this fails: profile discovery skips the install-default profile (the
// one browsers actually use) or picks an empty Default=1 dir instead of the
// one containing a real cookies.sqlite.
describe("findBrowserProfileDir", () => {
  test("prefers the install-default profile when it has a cookies.sqlite", () => {
    const root = mkdtempSync(join(tmpdir(), "gv-pf-root-"));
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "cookies.sqlite"), "");
    writeFileSync(
      join(root, "profiles.ini"),
      `[Profile1]\nIsRelative=1\nPath=empty\nDefault=1\n[InstallA]\nDefault=real\n`,
    );
    expect(findBrowserProfileDir([root])).toBe(real);
    rmSync(root, { recursive: true, force: true });
  });

  test("falls back to any dir containing cookies.sqlite when ini points nowhere", () => {
    const root = mkdtempSync(join(tmpdir(), "gv-pf-root-"));
    const stray = join(root, "stray");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "cookies.sqlite"), "");
    expect(findBrowserProfileDir([root])).toBe(stray);
    rmSync(root, { recursive: true, force: true });
  });
});

// Builds a synthetic moz_cookies database with two account partitions.
function buildFakeProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "gv-ff-profile-"));
  const db = new Database(join(dir, "cookies.sqlite"));
  db.run(`CREATE TABLE moz_cookies (
    id INTEGER PRIMARY KEY,
    originAttributes TEXT,
    name TEXT,
    value TEXT,
    host TEXT,
    path TEXT,
    expiry INTEGER,
    isSecure INTEGER,
    isHttpOnly INTEGER,
    sameSite INTEGER,
    creationTime INTEGER,
    lastAccessed INTEGER
  )`);
  const insert = db.prepare(
    "INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure) VALUES (?, ?, ?, ?, '/', 1822224120078, 1)",
  );
  // Voice account (default partition) — matches the SID anchor below.
  insert.run("", "SID", "g.a000VOICE", ".google.com");
  insert.run("", "SAPISID", "voice-sapisid-value", ".google.com");
  insert.run("", "SIDCC", "voice-sidcc-value", ".google.com");
  insert.run("", "COMPASS", "voice-api=x", "clients6.google.com");
  // Other account (container partition) — must NOT leak into the header.
  insert.run("^userContextId=2", "SID", "g.a000OTHER", ".google.com");
  insert.run("^userContextId=2", "SAPISID", "other-sapisid-value", ".google.com");
  insert.run("^userContextId=2", "SIDCC", "other-sidcc-value", ".google.com");
  db.close();
  return dir;
}

// If this fails: the reader exports cookies from the wrong account
// partition (leaking the container-tab account into the Voice session) or
// misses the correct SAPISID.
describe("readFirefoxSession", () => {
  test("reads the default partition and extracts SAPISID", () => {
    const dir = buildFakeProfile();
    const result = readFirefoxSession(dir);
    expect(result.sapisid).toBe("voice-sapisid-value");
    expect(result.cookie).toContain("SAPISID=voice-sapisid-value");
    expect(result.cookie).toContain("SIDCC=voice-sidcc-value");
    expect(result.cookie).not.toContain("other-sapisid-value");
    expect(result.cookie).not.toContain("other-sidcc-value");
    rmSync(dir, { recursive: true, force: true });
  });

  test("follows the SID anchor from GV_COOKIE into the container partition", () => {
    const dir = buildFakeProfile();
    const old = process.env.GV_COOKIE;
    process.env.GV_COOKIE = `SID=g.a000OTHER; SIDCC=stale`;
    try {
      const result = readFirefoxSession(dir);
      expect(result.sapisid).toBe("other-sapisid-value");
      expect(result.cookie).toContain("SIDCC=other-sidcc-value");
      expect(result.cookie).not.toContain("voice-sidcc-value");
    } finally {
      if (old === undefined) delete process.env.GV_COOKIE;
      else process.env.GV_COOKIE = old;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws a clear error when the profile has no cookies.sqlite", () => {
    const empty = mkdtempSync(join(tmpdir(), "gv-empty-profile-"));
    expect(() => readFirefoxSession(empty)).toThrow(/No cookies\.sqlite/);
    rmSync(empty, { recursive: true, force: true });
  });
});
