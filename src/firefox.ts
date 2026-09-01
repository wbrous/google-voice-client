/**
 * Reads a live Google session straight out of a Firefox-family browser
 * profile's `cookies.sqlite` (Firefox, Zen Browser, LibreWolf — same
 * `moz_cookies` schema). No browser automation, no login: whatever session
 * the user already has in their daily browser is exported as a `Cookie`
 * header + `SAPISID`.
 *
 * Caveat, learned the hard way: some setups (this one included — Zen with a
 * temporary/container tab, or heavy session-restore use) keep recent cookie
 * rotations in memory and write them to `cookies.sqlite` only later, so the
 * on-disk jar can be stale enough to 401. {@link refreshCookies} (a real
 * browser) is the fallback for those cases; the CLI tries this reader first
 * and verifies against the live API before trusting it.
 *
 * Multi-account: Firefox partitions cookies per account via the hidden
 * `originAttributes` column (e.g. `^userContextId=2` for container tabs).
 * The reader picks the partition whose `SID` value matches the one already
 * in `.env` (`GV_COOKIE`) when present, else the default (``) partition.
 */
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractCookieValue } from "./env";
import type { RefreshedCookies } from "./refresh";

const DEFAULT_PROFILE_ROOTS = [join(homedir(), ".config/zen"), join(homedir(), ".mozilla/firefox")];

/**
 * Parses a Firefox `profiles.ini`: returns the profile dir named by the
 * active `[Install*] Default=` section and, separately, the one flagged
 * `Default=1` in a `[Profile*]` section. Pure (no I/O) so it is testable.
 *
 * @precondition `content` is the text of a profiles.ini.
 * @postcondition Returns `{ installDefault, flaggedDefault }` with whichever
 *   paths were present (either may be undefined).
 */
export function parseProfilesIni(content: string): {
  installDefault?: string;
  flaggedDefault?: string;
} {
  const profiles: { path: string; isDefault: boolean }[] = [];
  let section = "";
  let current: { path?: string; isDefault: boolean } | null = null;
  let inInstall = false;
  let installDefault: string | undefined;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      if (current?.path) profiles.push({ path: current.path, isDefault: current.isDefault });
      section = line.slice(1, -1);
      inInstall = section.startsWith("Install");
      current = inInstall ? null : { isDefault: false };
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (inInstall) {
      if (key === "Default") installDefault = value;
      continue;
    }
    if (!current) continue;
    if (key === "Path") current.path = value;
    if (key === "Default") current.isDefault = value === "1";
  }
  if (current?.path) profiles.push({ path: current.path, isDefault: current.isDefault });

  return {
    installDefault,
    flaggedDefault: profiles.find((p) => p.isDefault)?.path,
  };
}

/**
 * Finds the first browser profile dir containing a `cookies.sqlite`:
 * candidates are the install-default and Default=1 profile from each
 * root's `profiles.ini`, in that order; falls back to any subdirectory of
 * a root that contains a cookies.sqlite.
 *
 * @precondition None.
 * @postcondition Returns a profile dir, or `null` if none of the configured
 *   roots contains a profile with a cookies.sqlite.
 */
export function findBrowserProfileDir(profileRoots: string[] = DEFAULT_PROFILE_ROOTS): string | null {
  for (const root of profileRoots) {
    const ini = join(root, "profiles.ini");
    if (existsSync(ini)) {
      const { installDefault, flaggedDefault } = parseProfilesIni(readFileSync(ini, "utf8"));
      for (const candidate of [installDefault, flaggedDefault]) {
        if (!candidate) continue;
        const dir = candidate.startsWith("/") ? candidate : join(root, candidate);
        if (existsSync(join(dir, "cookies.sqlite"))) return dir;
      }
    }
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      if (existsSync(join(dir, "cookies.sqlite"))) return dir;
    }
  }
  return null;
}

/**
 * Reads google.com cookies for one account partition out of a copied
 * cookies.sqlite.
 *
 * Partition selection: if `anchorCookieHeader` contains a `SID` value,
 * use the partition containing a `SID` row with that value (the account
 * already configured in `.env`); otherwise the default `` partition.
 *
 * @precondition `tmpDir` holds a copy of cookies.sqlite (+ -wal/-shm).
 * @postcondition Returns `{ cookie, sapisid }`; throws if no SAPISID is
 *   found in the selected partition.
 */
function readGooglePartition(
  tmpDir: string,
  anchorCookieHeader?: string,
): { cookie: string; sapisid: string } {
  const db = new Database(join(tmpDir, "cookies.sqlite"), { readonly: true });
  const anchorSid = anchorCookieHeader ? extractCookieValue(anchorCookieHeader, "SID") : undefined;

  let partition = "";
  if (anchorSid) {
    const row = db
      .query("SELECT originAttributes FROM moz_cookies WHERE name = 'SID' AND value = ? LIMIT 1")
      .get(anchorSid) as { originAttributes: string } | undefined;
    if (row) partition = row.originAttributes;
  }
  const rows = db
    .query(
      "SELECT name, value FROM moz_cookies WHERE host LIKE '%google.com' AND originAttributes = ? ORDER BY name",
    )
    .all(partition) as { name: string; value: string }[];
  const cookie = rows.map((r) => `${r.name}=${r.value}`).join("; ");
  const sapisid = rows.find((r) => r.name === "SAPISID")?.value;
  if (!sapisid) {
    throw new Error(`No SAPISID cookie in partition ${JSON.stringify(partition)} of the browser profile.`);
  }
  return { cookie, sapisid };
}

/**
 * Exports the Google session from a Firefox-family browser profile's
 * cookies.sqlite (see module doc for the freshness caveat).
 *
 * @precondition A Firefox/Zen/LibreWolf profile exists with a
 *   `cookies.sqlite` containing a logged-in google.com session.
 * @postcondition Returns `{ cookie, sapisid }` ready for
 *   {@link GoogleVoiceEnv}; throws if no profile is found, the DB cannot be
 *   read, or no SAPISID exists in the selected partition.
 */
export function readFirefoxSession(profileDir?: string): RefreshedCookies {
  const dir = profileDir ?? findBrowserProfileDir();
  if (!dir) {
    throw new Error(
      "No browser profile with cookies.sqlite found (checked ~/.config/zen and ~/.mozilla/firefox). " +
        "Pass an explicit profileDir, or use refreshCookies() instead.",
    );
  }
  const tmp = mkdtempSync(join(tmpdir(), "gv-cookies-"));
  try {
    for (const name of ["cookies.sqlite", "cookies.sqlite-wal", "cookies.sqlite-shm"]) {
      const p = join(dir, name);
      if (existsSync(p)) copyFileSync(p, join(tmp, name));
    }
    if (!existsSync(join(tmp, "cookies.sqlite"))) {
      throw new Error(
        `No cookies.sqlite in browser profile ${dir} — is a Firefox/Zen profile actually in use there?`,
      );
    }
    return readGooglePartition(tmp, process.env.GV_COOKIE);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
