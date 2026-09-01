/**
 * Keeps a Google Voice session alive without repeated manual cookie capture.
 *
 * Background: Google's short-lived session cookies (`SIDCC` and its `1P`/
 * `3P` variants) expire quickly and are normally refreshed by the browser
 * itself via a `POST https://accounts.google.com/RotateCookies` call, whose
 * request body is a bootstrap token minted by a real page load — there is
 * no way to obtain that token with plain HTTP requests. The long-lived
 * identity cookies (`SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, ...) last
 * much longer (routinely months), so the practical fix is the same thing a
 * browser does: keep one real, persistent, logged-in browser profile and
 * revisit voice.google.com periodically, letting its own JS perform the
 * rotation, then read the resulting cookie jar back out.
 *
 * Also considered and ruled out:
 * - Google account "app passwords" only authenticate legacy protocols
 *   (IMAP/SMTP/CalDAV); they have no relationship to www session cookies
 *   and cannot produce a `SAPISID`/`SIDCC` pair.
 * - There is no public OAuth-scoped API for consumer Google Voice SMS to
 *   exchange a refresh token against; this integration is inherently an
 *   unofficial session replay, so a real (if headless, persistent) browser
 *   is the only mechanism that can perform Google's actual rotation flow.
 *
 * Requires the optional `playwright` peer dependency (`bun add playwright`);
 * if Playwright's own downloaded Chromium isn't installed, a system
 * `chromium`/`chromium-browser`/`google-chrome` binary is used instead.
 */
import { existsSync } from "node:fs";
import type * as PlaywrightModule from "playwright";
import type { GoogleVoiceEnv } from "./env";

export interface RefreshCookiesOptions {
  /** Directory Playwright uses to persist the logged-in browser profile across runs. Default `.gv-browser-profile`. */
  profileDir?: string;
  /**
   * Run without a visible window. Default: `false` on a profile's first
   * run (so you can complete Google's login/2FA), `true` once cookies from
   * a prior successful run are already present in the profile.
   */
  headless?: boolean;
  /** Milliseconds to wait for voice.google.com to finish loading (and, on first run, for you to finish logging in). Default 120000. */
  timeoutMs?: number;
  /**
   * Explicit Chromium executable to launch. Default: Playwright's own
   * downloaded Chromium if present, else the first of
   * `/usr/bin/chromium`, `/usr/bin/chromium-browser`,
   * `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`.
   */
  executablePath?: string;
}

export interface RefreshedCookies {
  /** Full `Cookie` header value, ready to use as {@link GoogleVoiceEnv.cookie}. */
  cookie: string;
  /** `SAPISID` cookie value, ready to use as {@link GoogleVoiceEnv.sapisid}. */
  sapisid: string;
}

/**
 * Loads a `playwright` peer dependency that may not be installed.
 *
 * @precondition None.
 * @postcondition Resolves to the `playwright` module; throws a message
 *   pointing at the install command if it isn't present. Dynamic `import()`
 *   is required here (not a static import) because `playwright` is an
 *   optional peer dependency most consumers of this library never install.
 */
async function loadPlaywright(): Promise<typeof PlaywrightModule> {
  try {
    return (await import("playwright")) as typeof PlaywrightModule;
  } catch {
    throw new Error(
      'refreshCookies() requires the optional "playwright" peer dependency. ' +
        "Install it with: bun add playwright",
    );
  }
}

const SYSTEM_CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
];

/**
 * Picks the Chromium executable to launch: `options.executablePath` if
 * given, else Playwright's own downloaded build if installed, else the
 * first system chromium/chrome binary that exists.
 *
 * @precondition `options.executablePath`, if set, points at a launchable
 *   Chromium binary.
 * @postcondition Returns a path to use as `executablePath`; throws if
 *   neither an explicit path, a Playwright build, nor a system binary is
 *   available (with the install hint in the message).
 */
function resolveExecutablePath(
  playwright: typeof PlaywrightModule,
  options: RefreshCookiesOptions,
): string | undefined {
  if (options.executablePath) return options.executablePath;
  const bundled = playwright.chromium.executablePath();
  if (existsSync(bundled)) return bundled;
  return SYSTEM_CHROMIUM_CANDIDATES.find((path) => existsSync(path));
}

/**
 * Loads (or launches) a persistent, real Chromium profile at `profileDir`,
 * navigates to voice.google.com, and reads back the resulting cookie jar.
 *
 * On a fresh `profileDir` this opens a visible browser window and waits for
 * you to complete Google's login (and any 2FA) yourself; the profile then
 * stays logged in for future calls, which can run headless.
 *
 * @precondition The optional `playwright` peer dependency is installed
 *   (`bun add playwright`) and some Chromium binary is available (see
 *   {@link resolveExecutablePath}).
 * @postcondition Resolves once voice.google.com has loaded successfully in
 *   the profile and Google-domain cookies were read back; throws if
 *   `playwright`/a browser isn't available, or if navigation doesn't reach
 *   voice.google.com within `timeoutMs`.
 */
export async function refreshCookies(options: RefreshCookiesOptions = {}): Promise<RefreshedCookies> {
  const { profileDir = ".gv-browser-profile", timeoutMs = 120_000 } = options;
  const playwright = await loadPlaywright();
  const headless = options.headless ?? existsSync(profileDir);
  const executablePath = resolveExecutablePath(playwright, options);
  if (!executablePath) {
    throw new Error(
      "No Chromium binary found: install Playwright's build " +
        "(`bunx playwright install chromium`) or a system chromium/chrome package.",
    );
  }

  const context = await playwright.chromium.launchPersistentContext(profileDir, {
    headless,
    executablePath,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://voice.google.com/messages", {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    // If not already logged in, Google redirects to accounts.google.com;
    // wait until we're actually back on voice.google.com (i.e. logged in —
    // on a fresh profile this is where you complete login/2FA yourself).
    await page.waitForURL(/^https:\/\/voice\.google\.com\//, { timeout: timeoutMs });
    // Give the app shell a moment to finish its own RotateCookies exchange.
    await page.waitForTimeout(3000);

    const cookies = await context.cookies();
    const googleCookies = cookies.filter((c) => c.domain.replace(/^\./, "").endsWith("google.com"));
    if (googleCookies.length === 0) {
      throw new Error("No google.com cookies found in the browser profile after loading voice.google.com.");
    }
    const sapisid = googleCookies.find((c) => c.name === "SAPISID")?.value;
    if (!sapisid) {
      throw new Error("SAPISID cookie not found — the profile may not be logged in.");
    }
    return {
      cookie: googleCookies.map((c) => `${c.name}=${c.value}`).join("; "),
      sapisid,
    };
  } finally {
    await context.close();
  }
}

/**
 * Convenience wrapper: refreshes cookies and returns a ready-to-use
 * {@link GoogleVoiceEnv} fragment (everything except `apiKey`, which is a
 * fixed public value, not something the browser session provides).
 *
 * @precondition Same as {@link refreshCookies}.
 * @postcondition Same as {@link refreshCookies}.
 */
export async function refreshEnv(
  options?: RefreshCookiesOptions,
): Promise<Pick<GoogleVoiceEnv, "cookie" | "sapisid">> {
  return refreshCookies(options);
}
