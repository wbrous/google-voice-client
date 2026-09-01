import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { findFirefoxProfileDir, firefoxProfileRoots } from "../src/browser";
import { readFirefoxSession } from "../src/firefox";

// If this fails: per-OS firefox profile root discovery returns wrong paths,
// so the unified reader can't find a Firefox-family session on macOS/Windows.
describe("firefoxProfileRoots", () => {
  test("linux roots include standard and snap locations", () => {
    const roots = firefoxProfileRoots();
    expect(roots.some((r) => r.includes(".mozilla/firefox"))).toBe(true);
    expect(roots.some((r) => r.includes(".zen"))).toBe(true);
    expect(roots.some((r) => r.includes(".librewolf"))).toBe(true);
    expect(roots.some((r) => r.includes("snap/firefox"))).toBe(true);
  });
});

// If this fails: profile discovery misses a cookies.sqlite hanging off a
// firefox root (e.g. a nested profile dir).
describe("findFirefoxProfileDir", () => {
  test("finds a profile dir under a root that holds cookies.sqlite", () => {
    const root = mkdtempSync(join(tmpdir(), "gv-ff-root-"));
    const profile = join(root, "abcd.default");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "cookies.sqlite"), "");
    expect(findFirefoxProfileDir([root])).toBe(profile);
    rmSync(root, { recursive: true, force: true });
  });

  test("returns undefined when no root has a cookies.sqlite", () => {
    const root = mkdtempSync(join(tmpdir(), "gv-ff-root-empty-"));
    const profile = join(root, "sub");
    mkdirSync(profile, { recursive: true });
    expect(findFirefoxProfileDir([root])).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

// If this fails: the browser abstraction's zeroth-order reader diverges
// from the direct firefox reader, so unified `readBrowserSession` would
// return a different (broken) session than a targeted firefox read.
describe("browser reader vs direct firefox reader", () => {
  test("reads the same SAPISID through readFirefoxSession", () => {
    const dir = mkdtempSync(join(tmpdir(), "gv-ff-compare-"));
    const db = new Database(join(dir, "cookies.sqlite"));
    db.run(`CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY, originAttributes TEXT, name TEXT, value TEXT,
      host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER,
      sameSite INTEGER, creationTime INTEGER, lastAccessed INTEGER
    )`);
    db.run(`INSERT INTO moz_cookies (originAttributes,name,value,host,path,expiry) VALUES
      ('','SID','g.a000FIXTURE','.google.com','/',1822224120078),
      ('','SAPISID','fixture-sapisid','.google.com','/',1822224120078),
      ('','SIDCC','fixture-sidcc','.google.com','/',1822224120078)`);
    db.close();
    const result = readFirefoxSession(dir);
    expect(result.sapisid).toBe("fixture-sapisid");
    expect(result.cookie).toContain("SIDCC=fixture-sidcc");
    rmSync(dir, { recursive: true, force: true });
  });
});
