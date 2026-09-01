#!/usr/bin/env bun
/**
 * Export or import Playwright profile cookies as JSON.
 *
 * Usage:
 *   bun run cookies:export [file]     # default: cookies.json
 *   bun run cookies:import <file>     # inject into .gv-browser-profile
 *
 * Workflow (local → VPS):
 *   local$  bun run login             # sign in via GUI browser
 *   local$  bun run cookies:export    # writes cookies.json
 *   local$  scp cookies.json vps:~/discord-bridge/
 *   vps$    bun run cookies:import cookies.json
 *   vps$    bun run capture-tokens    # now works headlessly
 */
import { chromium } from "playwright";

const PROFILE_DIR = new URL("../.gv-browser-profile", import.meta.url).pathname;

const [action, ...rest] = process.argv.slice(2);

if (action === "export") {
  const outFile = rest[0] ?? "cookies.json";
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const cookies = await ctx.cookies();
  await ctx.close();
  await Bun.write(outFile, JSON.stringify(cookies, null, 2) + "\n");
  console.log(`[cookies] Exported ${cookies.length} cookies to ${outFile}`);
} else if (action === "import") {
  const inFile = rest[0];
  if (!inFile) {
    console.error("Usage: bun run cookies:import <file.json>");
    process.exit(1);
  }
  const raw = await Bun.file(inFile).text();
  const cookies = JSON.parse(raw);
  if (!Array.isArray(cookies)) {
    console.error("[cookies] Expected a JSON array of cookie objects.");
    process.exit(1);
  }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  await ctx.clearCookies();
  await ctx.addCookies(cookies);
  await ctx.close();
  console.log(`[cookies] Imported ${cookies.length} cookies into .gv-browser-profile`);
} else {
  console.error("Usage: bun run cookies:export [file] | bun run cookies:import <file>");
  process.exit(1);
}
