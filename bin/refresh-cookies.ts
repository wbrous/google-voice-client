#!/usr/bin/env bun
/**
 * CLI: refreshes `.env`'s GV_COOKIE by loading (or logging into) a
 * persistent browser profile and reading back a live Google session.
 *
 * First run (no `.gv-browser-profile/` yet): opens a visible browser
 * window — log into your Google account there (complete 2FA if prompted),
 * then leave the window open until this script reports success.
 *
 * Every run after that: reuses the saved, already-logged-in profile and
 * runs headless — safe to put on a cron job / systemd timer to keep
 * `.env` perpetually fresh without ever touching a browser again.
 *
 * Usage: bun run bin/refresh-cookies.ts [--headless] [--profile <dir>]
 */
import { refreshCookies } from "../src/refresh";
import { writeEnvCookie } from "../src/env";

const args = process.argv.slice(2);
const headless = args.includes("--headless") ? true : args.includes("--no-headless") ? false : undefined;
const profileIndex = args.indexOf("--profile");
const profileDir = profileIndex >= 0 ? args[profileIndex + 1] : undefined;

console.log("Loading Google Voice session (a browser window may open — log in there if prompted)...");
const { cookie } = await refreshCookies({ headless, profileDir });
writeEnvCookie(cookie);
console.log(`Wrote a fresh GV_COOKIE (${cookie.length} chars) to .env`);
