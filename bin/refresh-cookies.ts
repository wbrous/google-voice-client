#!/usr/bin/env bun
/**
 * CLI: refreshes `.env`'s GV_COOKIE by reading the Google session out of
 * any installed browser (Firefox/Zen via cookies.sqlite; Chrome, Brave,
 * Vivaldi, Opera, Edge, Arc, Safari via the optional @mherod/get-cookie
 * decryption), verifying it against the live API. If the on-disk jar is
 * stale (some setups keep cookie rotations in memory only), falls back to a
 * real browser: a persistent Playwright Chromium profile whose first run
 * opens a visible window for a one-time login (2FA included); later runs
 * stay logged in and work headless.
 *
 * Usage: bun run bin/refresh-cookies.ts [--source firefox|browser|auto]
 *                                        [--browser <name>] [--profile <dir>]
 *                                        [--headless] [--timeout <ms>]
 */
import type { SupportedBrowser } from "../src/browser";
import { readBrowserSession } from "../src/browser";
import { GoogleVoiceClient } from "../src/client";
import { loadEnv, writeEnvCookie, writeEnvVar } from "../src/env";
import { refreshCookies } from "../src/refresh";

const args = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const source = flagValue("--source") ?? "auto";
const browser = flagValue("--browser") as SupportedBrowser | undefined;
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

/** Reads the session from the real browser jar and verifies it live. */
async function jarRefresh(): Promise<void> {
  const { cookie, sapisid } = await readBrowserSession(browser);
  console.log(`Read GV_COOKIE from browser (${cookie.length} chars); verifying...`);
  if (!(await candidateIsLive(cookie, sapisid))) {
    throw new Error("Verification against the live API FAILED (401) — the on-disk jar is stale.");
  }
  writeEnvCookie(cookie);
  console.log("Verified live.");
}

if (source === "browser") {
  await browserRefresh();
} else if (source === "firefox") {
  await jarRefresh();
} else if (browser) {
  // auto with an explicit --browser target: try that browser's jar first.
  try {
    await jarRefresh();
    process.exit(0);
  } catch (err) {
    console.warn(`Browser jar failed (${err instanceof Error ? err.message : err}); falling back to Playwright...`);
  }
  await browserRefresh();
} else {
  // auto: prefer any real-browser jar; fall back to Playwright.
  try {
    await jarRefresh();
    process.exit(0);
  } catch (err) {
    console.warn(`Browser jar failed (${err instanceof Error ? err.message : err}); falling back to Playwright...`);
  }
  await browserRefresh();
}
