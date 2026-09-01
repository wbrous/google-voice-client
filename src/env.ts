import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Reads the Google Voice session credentials this client needs from the
 * process environment (populated from `.env` by the caller / bun's
 * built-in `.env` loading).
 *
 * @precondition GV_COOKIE and GV_API_KEY are set (see .env.example).
 * @postcondition Returns a fully-populated {@link GoogleVoiceEnv}; throws if
 *   a required variable is missing so misconfiguration fails at startup,
 *   not on the first request.
 */
export interface GoogleVoiceEnv {
  /** Full `Cookie` header value captured from an authenticated session. */
  cookie: string;
  /** Google API key used as the `key` query parameter (public, not secret). */
  apiKey: string;
  /** `SAPISID` (or `__Secure-3PAPISID`) cookie value, used to sign requests. */
  sapisid: string;
  /** `X-Goog-AuthUser` header value identifying which signed-in account to use. */
  authUser: string;
  /** `X-Client-Version` header value sent by the Voice web client. */
  clientVersion: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

/** Extracts a single cookie's value from a raw `Cookie` header string. */
export function extractCookieValue(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/**
 * Loads Google Voice credentials from the environment.
 *
 * @precondition `GV_COOKIE` and `GV_API_KEY` are set; `GV_SAPISID` is set or
 *   derivable from a `SAPISID`/`__Secure-3PAPISID` cookie inside `GV_COOKIE`.
 * @postcondition Returns credentials ready to pass to {@link GoogleVoiceClient}.
 */
export function loadEnv(): GoogleVoiceEnv {
  const cookie = requireEnv("GV_COOKIE");
  const apiKey = requireEnv("GV_API_KEY");
  const sapisid =
    process.env.GV_SAPISID ??
    extractCookieValue(cookie, "SAPISID") ??
    extractCookieValue(cookie, "__Secure-3PAPISID");
  if (!sapisid) {
    throw new Error(
      'Could not determine SAPISID: set GV_SAPISID explicitly, or ensure GV_COOKIE contains a "SAPISID" cookie.',
    );
  }
  return {
    cookie,
    apiKey,
    sapisid,
    authUser: process.env.GV_AUTH_USER ?? "0",
    clientVersion: process.env.GV_CLIENT_VERSION ?? "967950005",
  };
}

/**
 * Writes (or updates in place) the `GV_COOKIE=` line of an `.env` file,
 * leaving every other line untouched. Used to persist a cookie obtained
 * from {@link refreshCookies} so the next `loadEnv()` call picks it up.
 *
 * @precondition None; `envPath` need not already exist.
 * @postcondition `envPath` contains exactly one `GV_COOKIE=` line, set to
 *   `cookie` (double-quoted, since cookie headers routinely contain `;`),
 *   and ends with a trailing newline.
 */
export function writeEnvCookie(cookie: string, envPath = ".env"): void {
  const line = `GV_COOKIE="${cookie}"`;
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  // split keeps a trailing empty element when the file ends in "\n"; strip it
  // so re-joining doesn't produce a stray blank line, then re-add "\n" at end.
  const lines = existing.length > 0 ? existing.split("\n") : [""];
  if (lines[lines.length - 1] === "") lines.pop();
  const index = lines.findIndex((l) => l.startsWith("GV_COOKIE="));
  if (index >= 0) {
    lines[index] = line;
  } else {
    lines.push(line);
  }
  writeFileSync(envPath, lines.join("\n") + "\n");
}
