#!/usr/bin/env bun
/**
 * Captures a fresh WAA/BotGuard + reCAPTCHA token pair for outbound
 * Google Voice sends, then writes them into the bridge `.env`.
 *
 * Why this is needed: Google's `sendsms` endpoint returns 401 without two
 * anti-abuse tokens the web client mints by executing obfuscated JS in a
 * real page (WAA/BotGuard attestation + a reCAPTCHA-style token). Neither
 * can be fabricated; both are session-recent and short-lived, so they must
 * be re-captured periodically (like the session cookie).
 *
 * How it works:
 *  1. Launches a real Chromium window (reusing `.gv-browser-profile` if it
 *     exists, else creating it) and opens voice.google.com/messages.
 *  2. Hooks the network layer so the next `api2thread/sendsms` request is
 *     caught and the token pair (body index 10:
 *     `[attestation, null, null, recaptcha]`) is extracted.
 *  3. You send a real text message to any number in that window.
 *  4. The fresh pair is written to `.env`'s `GV_SEND_ATTESTATION_TOKEN` /
 *     `GV_SEND_RECAPTCHA_TOKEN`.
 *
 * Usage:
 *   bun run capture-tokens
 */
import { existsSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;
const PROFILE_DIR = new URL("../.gv-browser-profile", import.meta.url).pathname;

function envLines(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ENV_PATH)) return map;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
    if (m) map.set(m[1], m[2] ?? m[3] ?? "");
  }
  return map;
}

function setEnvVar(map: Map<string, string>, name: string, value: string): void {
  map.set(name, `"${value}"`);
}

function persist(map: Map<string, string>): void {
  const lines: string[] = [];
  for (const [k, v] of map) lines.push(`${k}=${v}`);
  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
  console.log(`Wrote ${map.size} env vars to ${ENV_PATH}`);
}

const initial = envLines();
if (!initial.has("DISCORD_TOKEN")) {
  console.error("No DISCORD_TOKEN set — the bridge needs it; add it to .env first.");
  process.exit(1);
}

console.log("Opening the browser. On voice.google.com, SEND A REAL MESSAGE to any number");
console.log("(e.g. an SMS to +10000000000) — the helper intercepts that send's request and");
console.log("grabs the fresh tokens from it.\n");

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
});
const page = context.pages()[0] ?? (await context.newPage());

// Resolve once a sendsms request with a botguardField is seen.
const tokens = new Promise<{ attestation: string; recaptcha: string }>((resolve) => {
  page.on("request", (req) => {
    if (!req.url().includes("api2thread/sendsms")) return;
    const data = req.postData();
    if (!data) return;
    try {
      const body = JSON.parse(data);
      const field = body?.[10]; // [attestation, null, null, recaptcha]
      if (Array.isArray(field) && field.length >= 4 && typeof field[0] === "string" && typeof field[3] === "string") {
        console.log("\nIntercepted a sendsms request — tokens captured.");
        resolve({ attestation: field[0], recaptcha: field[3] });
      }
    } catch {
      /* not JSON — ignore */
    }
  });
});

await page.goto("https://voice.google.com/messages", { waitUntil: "domcontentloaded" });
console.log("Waiting for you to send a message...\n");

try {
  const { attestation, recaptcha } = await Promise.race([
    tokens,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout: no send observed within 5 minutes.")), 300_000)),
  ]);
  setEnvVar(initial, "GV_SEND_ATTESTATION_TOKEN", attestation);
  setEnvVar(initial, "GV_SEND_RECAPTCHA_TOKEN", recaptcha);
  persist(initial);
  console.log("Done. The bridge can now send Discord→phone until these expire.");
} finally {
  await context.close();
}
