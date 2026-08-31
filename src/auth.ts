import { createHash } from "node:crypto";

/**
 * Computes a Google "SAPISIDHASH" authorization value, the scheme Google's
 * internal web clients (gapi, Voice, Gmail, ...) use to sign XHR requests
 * with a session cookie instead of an OAuth bearer token.
 *
 * Formula (reverse-engineered from Google's own `gapi.auth` client code):
 * `SHA1("{unixSeconds} {origin} {sapisid}")`, rendered as
 * `"{unixSeconds}_{hexDigest}"`.
 *
 * @precondition `sapisid` is the raw value of the `SAPISID` (or
 *   `__Secure-3PAPISID`) cookie from an authenticated google.com session.
 * @postcondition Returns a value usable directly as (part of) an
 *   `Authorization` header; deterministic for a given `unixSeconds`.
 */
export function computeSapisidHash(
  sapisid: string,
  origin: string,
  unixSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const digest = createHash("sha1").update(`${unixSeconds} ${origin} ${sapisid}`).digest("hex");
  return `${unixSeconds}_${digest}`;
}

/**
 * Builds the full `Authorization` header value Google Voice's web client
 * sends: three hashes (first-party, 1P, 3P variants) computed the same way
 * from the same SAPISID, differing only by label.
 *
 * @precondition Same as {@link computeSapisidHash}.
 * @postcondition Returns a header value of the form
 *   `"SAPISIDHASH x SAPISID1PHASH x SAPISID3PHASH x"`.
 */
export function buildAuthorizationHeader(
  sapisid: string,
  origin: string,
  unixSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const hash = computeSapisidHash(sapisid, origin, unixSeconds);
  return `SAPISIDHASH ${hash} SAPISID1PHASH ${hash} SAPISID3PHASH ${hash}`;
}
