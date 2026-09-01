#!/usr/bin/env bun
/**
 * Opens a persistent Chromium profile at voice.google.com so you can sign in
 * manually. The profile is saved to `.gv-browser-profile` — the same directory
 * `capture-tokens` reuses, so you only need to do this once.
 *
 * Usage:
 *   bun run login            # open browser, sign in, press Enter to close
 */
import { chromium } from "playwright";

const PROFILE_DIR = new URL("../.gv-browser-profile", import.meta.url).pathname;

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://voice.google.com/u/0/messages", { waitUntil: "domcontentloaded" });

console.log("[login] Browser is open. Sign in to Google Voice, then press Enter here to close.");
for await (const line of console) {
  break;
}

await ctx.close();
console.log("[login] Profile saved to .gv-browser-profile — capture-tokens will reuse it.");
