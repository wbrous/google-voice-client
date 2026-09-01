#!/usr/bin/env bun
/**
 * CLI: refreshes `.env`'s GV_COOKIE by reading the Google session out of
 * your Firefox/Zen browser profile, then verifying it against the live API.
 * If the on-disk browser jar is stale (some setups keep cookie rotations in
 * memory only), falls back to a real browser: a persistent Playwright
 * Chromium profile whose first run opens a visible window for a one-time
 * login (2FA included); later runs stay logged in and work headless.
 *
 * Usage: bun run bin/refresh-cookies.ts [--source firefox|browser|auto]
 *                                        [--profile <dir>] [--headless] [--timeout <ms>]
 */
import { GoogleVoiceClient } from "../src/client";
import { loadEnv, writeEnvCookie, writeEnvVar } from "../src/env";
import { readFirefoxSession } from "../src/firefox";
import { refreshCookies } from "../src/refresh";

const args = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const source = flagValue("--source") ?? "auto";
const profileDir = flagValue("--profile");
const headless = args.includes("--headless") ? true : args.includes("--no-headless") ? false : undefined;
const timeoutMs = Number(flagValue("--timeout") ?? 120_000);

/** Verifies a candidate cookie against the live API before it touches .env. */
async function candidateIsLive(cookie: string, sapisid: string): Promise<boolean> {
  try {
    const env = loadEnv();
    const client = new GoogleVoiceClient({ ...env, cookie, sapisid });
    await client.listThreads();
    return true;
  } catch {
    return false;
  }
}

/**
 * The Playwright profile is single-account (you log in once), so Voice
 * lives at authuser 0 there — unlike the browser-jar flow, which preserves
 * whatever account layout the user's real browser has.
 */
async function browserRefresh(): Promise<void> {
  console.log("Loading Google Voice session (a browser window may open — log in there if prompted)...");
  const { cookie } = await refreshCookies({ headless, profileDir, timeoutMs });
  writeEnvCookie(cookie);
  writeEnvVar("GV_AUTH_USER", "0");
  console.log(`Wrote a fresh GV_COOKIE (${cookie.length} chars) to .env`);
}

if (source === "browser") {
  await browserRefresh();
} else if (source === "firefox") {
  const { cookie, sapisid } = readFirefoxSession(profileDir);
  if (!(await candidateIsLive(cookie, sapisid))) {
    console.error("Verification against the live API FAILED (401) — the on-disk jar is stale.");
    process.exit(1);
  }
  writeEnvCookie(cookie);
  console.log(`Wrote GV_COOKIE from browser profile (${cookie.length} chars) and verified it live.`);
} else {
  // auto: prefer the browser-profile read; fall back to a real browser.
  try {
    const { cookie, sapisid } = readFirefoxSession(profileDir);
    console.log(`Read GV_COOKIE from browser profile (${cookie.length} chars); verifying...`);
    if (await candidateIsLive(cookie, sapisid)) {
      writeEnvCookie(cookie);
      console.log("Verified live.");
      process.exit(0);
    }
    console.warn("On-disk browser jar is stale (401); falling back to the Playwright refresh flow...");
  } catch (err) {
    console.warn(
      `Browser-profile read failed (${err instanceof Error ? err.message : err}); falling back to Playwright...`,
    );
  }
  await browserRefresh();
}
