/**
 * Ambient declaration for `@mherod/get-cookie`, an *optional* peer dependency.
 *
 * The module is import()'d dynamically in `src/browser.ts`. tsc still needs to
 * resolve the specifier at compile time even for a dynamic import, which fails
 * with TS2307 when the optional peer isn't installed (notably in CI, where
 * `bun install --frozen-lockfile` won't pull optional peers). Declaring the
 * module here satisfies the resolver no matter what, and the structural types
 * below also let consumers who deliberately skip the heavy peer stay type-safe.
 *
 * The shape mirrors only the surface `google-voice-client` actually uses; the
 * real package has far more. Do not import these by name — use `import()` and
 * cast, as `src/browser.ts` does.
 */
declare module "@mherod/get-cookie" {
  export interface ExportedCookie {
    name: string;
    value: unknown;
    domain?: string;
  }
  export class ChromiumCookieQueryStrategy {
    constructor(browser?: string);
    queryCookies(name: string, domain: string): Promise<ExportedCookie[]>;
  }
  export class SafariCookieQueryStrategy {
    queryCookies(name: string, domain: string): Promise<ExportedCookie[]>;
  }
}
