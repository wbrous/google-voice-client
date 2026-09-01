#!/usr/bin/env bun
/**
 * Automatically captures a fresh WAA/BotGuard + reCAPTCHA send-token pair by
 * driving a real (headless) Chromium session: open voice.google.com/messages,
 * click through the thread list until the one for `BRIDGE_PHONE` is found (by
 * URL `itemId`, not by fragile contact-name text matching), type and send an
 * "[AUTOMATED] Refreshing tokens..." message, and intercept the resulting
 * `api2thread/sendsms` request body for the token pair.
 *
 * Why a *real* send is required: Google's `sendsms` endpoint rejects requests
 * without these two anti-abuse tokens, and the tokens are minted by the page's
 * own obfuscated JS only when an actual send happens through the UI — they
 * cannot be fabricated or intercepted any other way. Driving a synthetic new
 * conversation (typing a raw phone number into the recipient picker) does
 * NOT trigger a real send, because Voice requires the number to be a saved
 * Google Contact; clicking an *existing* thread from the list does.
 *
 * Runs once, or continuously every `REFRESH_MINUTES` minutes when invoked
 * with `--loop` (or `LOOP=1`). Reuses `.gv-browser-profile` (created here if
 * absent) so no login flow runs after the first successful capture.
 *
 * Usage:
 *   bun run refresh-tokens          # capture once
 *   LOOP=1 bun run refresh-tokens   # capture, then every REFRESH_MINUTES (default 60)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;
const PROFILE_DIR = new URL("../.gv-browser-profile", import.meta.url).pathname;
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES ?? "60");
const LOOP = process.env.LOOP === "1" || process.argv.includes("--loop");
const HEADLESS = process.env.HEADLESS !== "0";
const MESSAGE_TEXT = "[AUTOMATED] Refreshing tokens...";

function envLines(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ENV_PATH)) return map;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
    if (m) map.set(m[1], m[2] ?? m[3] ?? "");
  }
  return map;
}

function setEnvVar(name: string, value: string): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  const escaped = `"${value.replace(/"/g, '\\"')}"`;
  const idx = lines.findIndex((l) => l.startsWith(`${name}=`));
  const line = `${name}=${escaped}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  writeFileSync(ENV_PATH, lines.join("\n"));
}

/** Normalizes a phone number to digits-only for itemId matching. */
function digitsOf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Runs one capture cycle: opens Voice, finds the thread whose `itemId`
 * matches `BRIDGE_PHONE`'s digits, sends the refresh message through it, and
 * writes the intercepted token pair to `.env`. Returns true on success.
 */
async function captureOnce(): Promise<boolean> {
  const phone = process.env.BRIDGE_PHONE;
  if (!phone) throw new Error("Missing required environment variable BRIDGE_PHONE");
  const wantDigits = digitsOf(phone);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  let tokens: { attestation: string; recaptcha: string } | null = null;
  let sendOk = false;
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.on("response", async (res) => {
      if (!res.url().includes("api2thread/sendsms")) return;
      sendOk = res.ok();
    });
    page.on("request", (req) => {
      if (!req.url().includes("api2thread/sendsms")) return;
      try {
        const body = JSON.parse(req.postData() ?? "null") as unknown[] | null;
        const field = body?.[10] as unknown[] | undefined;
        if (Array.isArray(field) && typeof field[0] === "string" && typeof field[3] === "string") {
          tokens = { attestation: field[0], recaptcha: field[3] };
        }
      } catch {
        // Ignore unparseable sendsms bodies — tokens stay null and the
        // caller reports failure.
      }
    });

    await page.goto("https://voice.google.com/u/0/messages", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    // Click through thread-list rows (not by fragile contact-name text) and
    // stop once the URL's itemId digits match BRIDGE_PHONE.
    const rows = page.locator(".mat-ripple.container");
    const rowCount = await rows.count();
    let found = false;
    for (let i = 0; i < rowCount; i++) {
      await rows.nth(i).click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const m = page.url().match(/itemId=t\.([^&]+)/);
      const itemDigits = m ? digitsOf(decodeURIComponent(m[1])) : "";
      if (itemDigits && (itemDigits === wantDigits || itemDigits.endsWith(wantDigits) || wantDigits.endsWith(itemDigits))) {
        found = true;
        break;
      }
    }
    if (!found) {
      console.error(`[refresh-tokens] No existing Voice thread found for ${phone}. Send it one message from voice.google.com first.`);
      return false;
    }

    const composer = page.locator('textarea[placeholder="Type a message"]');
    await composer.waitFor({ state: "visible", timeout: 15_000 });
    await composer.click();
    await composer.fill(MESSAGE_TEXT);
    await page.waitForTimeout(500);
    await composer.press("Enter");
    await page.waitForTimeout(4000);
  } finally {
    await ctx.close().catch(() => {});
  }

  if (!tokens || !sendOk) {
    console.error("[refresh-tokens] Send did not complete or tokens were not captured.");
    return false;
  }
  const captured = tokens;
  setEnvVar("GV_SEND_ATTESTATION_TOKEN", captured.attestation);
  setEnvVar("GV_SEND_RECAPTCHA_TOKEN", captured.recaptcha);
  console.log(`[refresh-tokens] Captured fresh send tokens at ${new Date().toISOString()}.`);
  return true;
}

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

if (LOOP) {
  console.log(`[refresh-tokens] Loop mode: refreshing every ${REFRESH_MINUTES} minutes.`);
  for (;;) {
    await captureOnce().catch((err) => console.error("[refresh-tokens] cycle failed:", err instanceof Error ? err.message : err));
    await delay(REFRESH_MINUTES * 60_000);
  }
} else {
  const ok = await captureOnce();
  process.exit(ok ? 0 : 1);
}
