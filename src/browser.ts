/**
 * Unified cross-browser Google Voice session exporter.
 *
 * Reads the logged-in google.com session out of any installed browser:
 * - **Firefox-family** (Firefox, Zen, LibreWolf, Waterfox): direct
 *   `cookies.sqlite` read — unencrypted, zero dependencies.
 * - **Chromium-family** (Chrome, Chromium, Edge, Brave, Opera, Opera GX,
 *   Vivaldi, Arc) and **Safari**: cookies are encrypted (AES-GCM behind an
 *   OS-keyring/DPAPI/Keychain key) and come in other formats (binarycookies
 *   for Safari), so this module delegates to `@mherod/get-cookie` — the
 *   battle-tested library that handles every platform's decryption. It is
 *   an *optional* peer dependency: consume it only if you need Chromium or
 *   Safari support; the Firefox reader needs nothing.
 *
 * The exported surface never references `@mherod/get-cookie` types, so
 * packages without the peer dependency stay type-safe and tree-shakeable.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExportedCookie } from "@mherod/get-cookie";
import type { GoogleVoiceEnv } from "./env";
import { readFirefoxSession } from "./firefox";
import type { RefreshedCookies } from "./refresh";

export type SupportedBrowser =
  | "firefox"
  | "zen"
  | "chrome"
  | "chromium"
  | "edge"
  | "brave"
  | "opera"
  | "opera-gx"
  | "vivaldi"
  | "arc"
  | "safari";

/** Maps our browser names to the strings `@mherod/get-cookie` understands. */
const GET_COOKIE_BROWSER_ALIAS: Record<Exclude<SupportedBrowser, "firefox" | "zen">, string> = {
  chrome: "chrome",
  chromium: "chromium",
  edge: "edge",
  brave: "brave",
  opera: "opera",
  "opera-gx": "opera-gx",
  vivaldi: "vivaldi",
  arc: "arc",
  safari: "safari",
};

/**
 * Firefox-family browser profile roots to probe, in discovery order, per OS.
 *
 * @precondition None.
 * @postcondition Returns absolute candidate root dirs (may not exist).
 */
export function firefoxProfileRoots(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      join(home, "Library/Application Support/Firefox/Profiles"),
      join(home, "Library/Application Support/LibreWolf/Profiles"),
    ];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData/Roaming");
    return [
      join(appData, "Mozilla/Firefox/Profiles"),
      join(appData, "Mozilla/Firefox"),
      join(appData, "LibreWolf/Profiles"),
    ];
  }
  return [
    join(home, ".zen/config"),
    join(home, ".mozilla/firefox"),
    join(home, ".librewolf"),
    join(home, ".waterfox"),
    join(home, ".config/zen"),
    join(home, "snap/firefox/common/.mozilla/firefox"),
  ];
}

/**
 * Locates the first Firefox-family profile directory holding a
 * `cookies.sqlite` under any of the given roots.
 *
 * @precondition None.
 * @postcondition Returns an absolute profile dir, or `undefined`.
 */
export function findFirefoxProfileDir(roots: string[] = firefoxProfileRoots()): string | undefined {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root)) {
        const dir = join(root, entry);
        if (existsSync(join(dir, "cookies.sqlite"))) return dir;
      }
      if (existsSync(join(root, "cookies.sqlite"))) return root;
    } catch {
      /* unreadable root — try the next */
    }
  }
  return undefined;
}

/**
 * Detects which installed browsers currently hold a google.com session.
 *
 * @precondition None.
 * @postcondition Returns the ordered list of supported browsers found.
 */
export function detectBrowsers(): SupportedBrowser[] {
  const found: SupportedBrowser[] = [];
  const firefoxDir = findFirefoxProfileDir();
  if (firefoxDir) {
    // Zen keeps its profile under ~/.zen/config; anything not under that
    // is vanilla Firefox/derivative.
    found.push(/[\\/]\.zen[\\/]/i.test(firefoxDir) ? "zen" : "firefox");
  }
  return found;
}

/**
 * Reads the google.com session from a specific browser (or the first browser
 * that yields one if none is given).
 *
 * @precondition For Chromium-family/Safari: `@mherod/get-cookie` peer is
 *   installed (`bun add @mherod/get-cookie`).
 * @postcondition Resolves to `{ cookie, sapisid }`; throws if no browser
 *   yields a google.com session containing a SAPISID cookie.
 */
export async function readBrowserSession(browser?: SupportedBrowser): Promise<RefreshedCookies> {
  if (browser) {
    if (browser === "firefox" || browser === "zen") {
      const dir = findFirefoxProfileDir();
      if (!dir) throw new Error(`No ${browser} profile with cookies.sqlite found.`);
      return readFirefoxSession(dir);
    }
    if (browser === "safari") return readSafari();
    return readChromiumLike(browser);
  }
  // Auto: whichever browser has a session.
  const any = await readAllBrowsers();
  if (any) return any;
  throw new Error(
    "No browser with a google.com session was found. Log into voice.google.com in a supported " +
      "browser, then retry.",
  );
}

/** Tries every detected browser and returns the first session that parses. */
async function readAllBrowsers(): Promise<RefreshedCookies | undefined> {
  for (const b of detectBrowsers()) {
    try {
      return await readBrowserSession(b);
    } catch {
      /* try the next browser */
    }
  }
  return undefined;
}

// The module surface is declared in src/get-cookie-env.d.ts, so tsc resolves
// it whether or not the optional peer is installed; `import()` is dynamic so
// the runtime never loads it unless a Chromium-family/Safari read is needed.
type GetCookieModule = typeof import("@mherod/get-cookie");

/** Reads a Chromium-family browser via the optional `@mherod/get-cookie` peer. */
async function readChromiumLike(
  browser: Exclude<SupportedBrowser, "firefox" | "zen" | "safari">,
): Promise<RefreshedCookies> {
  const mod = await loadGetCookie();
  const strategy = new mod.ChromiumCookieQueryStrategy(GET_COOKIE_BROWSER_ALIAS[browser]);
  const cookies = await strategy.queryCookies("%", "google.com");
  return cookiesToHeader(cookies);
}

/** Reads Safari via the optional `@mherod/get-cookie` peer. */
async function readSafari(): Promise<RefreshedCookies> {
  const mod = await loadGetCookie();
  const strategy = new mod.SafariCookieQueryStrategy();
  const cookies = await strategy.queryCookies("%", "google.com");
  return cookiesToHeader(cookies);
}

/**
 * Loads the optional `@mherod/get-cookie` peer dependency.
 *
 * @precondition None.
 * @postcondition Resolves to the module; throws a message pointing at the
 *   install command if it isn't present. Dynamic `import()` is required
 *   (not static) because this is an optional peer dependency most consumers
 *   never install.
 */
async function loadGetCookie(): Promise<GetCookieModule> {
  try {
    return await import("@mherod/get-cookie");
  } catch {
    throw new Error(
      'Reading Chromium-family or Safari sessions requires the optional "@mherod/get-cookie" ' +
        "peer dependency. Install it with: bun add @mherod/get-cookie",
    );
  }
}

/** Turns browser-cookie rows into a Cookie header + extracted SAPISID. */
function cookiesToHeader(cookies: ExportedCookie[]): RefreshedCookies {
  const header = cookies
    .map((c) => `${c.name}=${typeof c.value === "string" ? c.value : JSON.stringify(c.value)}`)
    .join("; ");
  const sapisid = cookies.find((c) => c.name === "SAPISID")?.value;
  if (!sapisid) throw new Error("No SAPISID cookie found in the rendered browser session.");
  return { cookie: header, sapisid: String(sapisid) };
}

// Re-export is intentional: keeps GoogleVoiceEnv public for docs without a
// new import surface.
export type { GoogleVoiceEnv };
