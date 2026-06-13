/**
 * Next.js Compatibility Tests: reactMaxHeadersLength
 *
 * Ported from Next.js: test/e2e/app-dir/react-max-headers-length/react-max-headers-length.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/react-max-headers-length/react-max-headers-length.test.ts
 *
 * `reactMaxHeadersLength` caps the total length of the preload `Link` header
 * emitted during App Router SSR. React drops whole entries once the limit is
 * exceeded (default 6000; `0` disables emission entirely). See
 * cloudflare/vinext#1552.
 *
 * The upstream fixture asserts against React `ReactDOM.preload()` hints. vinext
 * emits its preload `Link` header from the App Router font pipeline (the route
 * inherits the fixture's `next/font` preloads), so this test exercises the same
 * cap/truncation contract against that header.
 */
import { describe, it, expect, afterEach } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

const ROUTE = "/nextjs-compat/react-max-headers-length";

/** Split a `Link` header into its individual entries. */
function linkEntries(header: string): string[] {
  return header.split(", ").filter((entry) => entry.length > 0);
}

describe("Next.js compat: reactMaxHeadersLength", () => {
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    delete process.env.TEST_REACT_MAX_HEADERS_LENGTH;
  });

  async function fetchLinkHeader(value: number | undefined): Promise<string | null> {
    if (typeof value === "number") {
      process.env.TEST_REACT_MAX_HEADERS_LENGTH = String(value);
    } else {
      delete process.env.TEST_REACT_MAX_HEADERS_LENGTH;
    }
    const started = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true });
    server = started.server;
    const res = await fetch(`${started.baseUrl}${ROUTE}`);
    expect(res.status).toBe(200);
    return res.headers.get("Link");
  }

  it("emits an uncapped Link header when reactMaxHeadersLength is unset", async () => {
    const header = await fetchLinkHeader(undefined);
    // Default cap is 6000; the fixture's font preloads stay well under it, so
    // the full header is emitted.
    expect(header).not.toBeNull();
    expect(header!.length).toBeLessThanOrEqual(6000);
    expect(header).toMatch(/rel=preload/);
  }, 60_000);

  it("does not emit a Link header when reactMaxHeadersLength is 0", async () => {
    const header = await fetchLinkHeader(0);
    expect(header).toBeNull();
  }, 60_000);

  it("truncates the Link header to whole entries within a small cap (200)", async () => {
    const full = await fetchLinkHeader(undefined);
    expect(full).not.toBeNull();
    await server?.close();
    server = undefined;

    const capped = await fetchLinkHeader(200);
    expect(capped).not.toBeNull();
    // Respects the cap...
    expect(capped!.length).toBeLessThanOrEqual(200);
    // ...by dropping whole entries (each surviving entry is intact, never a
    // partial slice of an entry).
    const fullEntries = new Set(linkEntries(full!));
    for (const entry of linkEntries(capped!)) {
      expect(fullEntries.has(entry)).toBe(true);
    }
    // A smaller cap emits fewer entries than the uncapped header.
    expect(linkEntries(capped!).length).toBeLessThan(fullEntries.size);
  }, 60_000);

  it("emits more entries for a larger cap than a smaller one", async () => {
    const small = await fetchLinkHeader(200);
    expect(small).not.toBeNull();
    const smallCount = linkEntries(small!).length;
    await server?.close();
    server = undefined;

    const large = await fetchLinkHeader(6000);
    expect(large).not.toBeNull();
    expect(large!.length).toBeLessThanOrEqual(6000);
    expect(linkEntries(large!).length).toBeGreaterThanOrEqual(smallCount);
  }, 60_000);
});
