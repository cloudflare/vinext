/**
 * Tests for seeding Workers KV cache from pre-rendered routes at deploy time.
 *
 * Verifies that seedKVCacheFromPrerender() reads vinext-prerender.json and
 * the corresponding HTML/RSC files from disk, constructs correct ISR cache
 * keys, serializes entries in the KVCacheEntry format, and uploads them via
 * the Cloudflare KV bulk REST API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isrCacheKey } from "../packages/vinext/src/server/isr-cache.js";
import {
  seedKVCacheFromPrerender,
  uploadBulkToKV,
} from "../packages/vinext/src/cloudflare/seed-kv-cache.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-seed-kv-"));
}

/**
 * Set up a mock build output with vinext-prerender.json and prerendered files.
 */
function setupFixture(
  root: string,
  manifest: { buildId: string; trailingSlash?: boolean; routes: unknown[] },
  files: Record<string, string | Buffer>,
): void {
  const serverDir = path.join(root, "dist", "server");
  fs.mkdirSync(serverDir, { recursive: true });

  fs.writeFileSync(
    path.join(serverDir, "vinext-prerender.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  const prerenderDir = path.join(serverDir, "prerendered-routes");
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(prerenderDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (typeof content === "string") {
      fs.writeFileSync(fullPath, content, "utf-8");
    } else {
      fs.writeFileSync(fullPath, content);
    }
  }
}

/** Capture fetch calls for assertions. */
type CapturedFetch = {
  url: string;
  method: string;
  body: unknown[];
  headers: Record<string, string>;
};

function mockFetchSuccess(): { calls: CapturedFetch[]; restore: () => void } {
  const calls: CapturedFetch[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(init.body as string) : [];
    calls.push({
      url,
      method: init?.method ?? "GET",
      body,
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)]),
      ),
    });
    // Return a fresh Response each time — Response.json() can only be consumed once
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function mockFetchFailure(status: number, text: string): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response(text, { status })) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// ─── Test constants ───────────────────────────────────────────────────────────

const TEST_OPTIONS = {
  accountId: "test-account-123",
  namespaceId: "test-namespace-456",
  apiToken: "test-token-789",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("seedKVCacheFromPrerender", () => {
  let root: string;
  let fetchMock: ReturnType<typeof mockFetchSuccess>;

  beforeEach(() => {
    root = createTempRoot();
    fetchMock = mockFetchSuccess();
  });

  afterEach(() => {
    fetchMock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── Basic seeding ─────────────────────────────────────────────────────────

  it("seeds App Router routes with correct KV key format", async () => {
    const buildId = "build-001";
    setupFixture(
      root,
      {
        buildId,
        routes: [{ route: "/about", status: "rendered", revalidate: 60, router: "app" }],
      },
      {
        "about.html": "<html><body>About</body></html>",
        "about.rsc": "RSC payload for about",
      },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });

    expect(result.seededRoutes).toBe(1);
    expect(result.kvPairsUploaded).toBe(2); // html + rsc
    expect(result.skipped).toBeUndefined();

    // Verify the KV pairs sent to the API
    const pairs = fetchMock.calls[0].body as Array<{ key: string; value: string }>;
    expect(pairs).toHaveLength(2);

    // HTML key: cache:app:<buildId>:<pathname>:html
    const expectedBaseKey = isrCacheKey("app", "/about", buildId);
    expect(pairs[0].key).toBe(`cache:${expectedBaseKey}:html`);
    expect(pairs[1].key).toBe(`cache:${expectedBaseKey}:rsc`);

    // Verify HTML entry value format
    const htmlEntry = JSON.parse(pairs[0].value);
    expect(htmlEntry.value.kind).toBe("APP_PAGE");
    expect(htmlEntry.value.html).toBe("<html><body>About</body></html>");
    expect(htmlEntry.value.rscData).toBeUndefined();
    expect(htmlEntry.tags).toEqual([]);
    expect(htmlEntry.lastModified).toBeTypeOf("number");
    expect(htmlEntry.revalidateAt).toBeTypeOf("number");

    // Verify RSC entry value format — rscData is base64-encoded
    const rscEntry = JSON.parse(pairs[1].value);
    expect(rscEntry.value.kind).toBe("APP_PAGE");
    expect(rscEntry.value.html).toBe("");
    expect(rscEntry.value.rscData).toBe(Buffer.from("RSC payload for about").toString("base64"));
  });

  it("seeds multiple routes in a single upload", async () => {
    const buildId = "build-002";
    setupFixture(
      root,
      {
        buildId,
        routes: [
          { route: "/about", status: "rendered", revalidate: 60, router: "app" },
          { route: "/contact", status: "rendered", revalidate: false, router: "app" },
        ],
      },
      {
        "about.html": "<html>About</html>",
        "about.rsc": "rsc-about",
        "contact.html": "<html>Contact</html>",
        "contact.rsc": "rsc-contact",
      },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(2);
    expect(result.kvPairsUploaded).toBe(4); // 2 routes * 2 entries each
  });

  it("seeds index route correctly", async () => {
    const buildId = "build-003";
    setupFixture(
      root,
      {
        buildId,
        routes: [{ route: "/", status: "rendered", revalidate: false, router: "app" }],
      },
      {
        "index.html": "<html>Home</html>",
        "index.rsc": "rsc-home",
      },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);

    const pairs = fetchMock.calls[0].body as Array<{ key: string; value: string }>;
    const expectedBaseKey = isrCacheKey("app", "/", buildId);
    expect(pairs[0].key).toBe(`cache:${expectedBaseKey}:html`);
  });

  it("uses path field for dynamic routes", async () => {
    const buildId = "build-004";
    setupFixture(
      root,
      {
        buildId,
        routes: [
          {
            route: "/blog/:slug",
            status: "rendered",
            revalidate: 120,
            router: "app",
            path: "/blog/hello-world",
          },
        ],
      },
      {
        "blog/hello-world.html": "<html>Blog Post</html>",
        "blog/hello-world.rsc": "rsc-blog",
      },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);

    const pairs = fetchMock.calls[0].body as Array<{ key: string }>;
    const expectedBaseKey = isrCacheKey("app", "/blog/hello-world", buildId);
    expect(pairs[0].key).toBe(`cache:${expectedBaseKey}:html`);
  });

  // ── Revalidation ──────────────────────────────────────────────────────────

  it("sets revalidateAt for ISR routes", async () => {
    setupFixture(
      root,
      {
        buildId: "build-005",
        routes: [{ route: "/isr", status: "rendered", revalidate: 300, router: "app" }],
      },
      { "isr.html": "<html>ISR</html>" },
    );

    const before = Date.now();
    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    const after = Date.now();

    expect(result.seededRoutes).toBe(1);

    const pairs = fetchMock.calls[0].body as Array<{
      key: string;
      value: string;
      expiration_ttl: number;
    }>;
    const entry = JSON.parse(pairs[0].value);

    // revalidateAt should be ~now + 300s
    expect(entry.revalidateAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(entry.revalidateAt).toBeLessThanOrEqual(after + 300_000);

    // KV TTL: 10x revalidate = 3000s
    expect(pairs[0].expiration_ttl).toBe(3000);
  });

  it("sets null revalidateAt and no expiration_ttl for static routes", async () => {
    setupFixture(
      root,
      {
        buildId: "build-006",
        routes: [{ route: "/static", status: "rendered", revalidate: false, router: "app" }],
      },
      { "static.html": "<html>Static</html>" },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);

    const pairs = fetchMock.calls[0].body as Array<{
      key: string;
      value: string;
      expiration_ttl?: number;
    }>;
    const entry = JSON.parse(pairs[0].value);

    expect(entry.revalidateAt).toBeNull();
    // Static routes: no expiry (matches runtime KVCacheHandler.set behavior)
    expect(pairs[0].expiration_ttl).toBeUndefined();
  });

  // ── Skip conditions ───────────────────────────────────────────────────────

  it("skips when no manifest exists", async () => {
    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.skipped).toBe("no vinext-prerender.json found");
    expect(result.seededRoutes).toBe(0);
  });

  it("skips when manifest is corrupt", async () => {
    const serverDir = path.join(root, "dist", "server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "vinext-prerender.json"), "NOT JSON", "utf-8");

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.skipped).toBe("failed to parse vinext-prerender.json");
  });

  it("skips when manifest has no buildId", async () => {
    setupFixture(root, { buildId: "", routes: [] }, {});

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.skipped).toBe("manifest missing buildId or routes");
  });

  it("skips Pages Router routes", async () => {
    setupFixture(
      root,
      {
        buildId: "build-007",
        routes: [{ route: "/old-page", status: "rendered", revalidate: false, router: "pages" }],
      },
      { "old-page.html": "<html>Pages Router</html>" },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.skipped).toBe("no pre-rendered App Router routes found");
  });

  it("skips routes with non-rendered status", async () => {
    setupFixture(
      root,
      {
        buildId: "build-008",
        routes: [
          { route: "/dynamic", status: "skipped", reason: "ssr" },
          { route: "/broken", status: "error", error: "oops" },
        ],
      },
      {},
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.skipped).toBe("no pre-rendered App Router routes found");
  });

  it("skips routes when HTML file is missing on disk", async () => {
    setupFixture(
      root,
      {
        buildId: "build-009",
        routes: [{ route: "/ghost", status: "rendered", revalidate: false, router: "app" }],
      },
      {}, // no files on disk
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.skipped).toBe("no pre-rendered App Router routes found");
  });

  it("seeds HTML-only when RSC file is missing", async () => {
    setupFixture(
      root,
      {
        buildId: "build-010",
        routes: [{ route: "/html-only", status: "rendered", revalidate: false, router: "app" }],
      },
      { "html-only.html": "<html>HTML Only</html>" },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);
    expect(result.kvPairsUploaded).toBe(1); // only html, no rsc
  });

  // ── Trailing slash ────────────────────────────────────────────────────────

  it("handles trailingSlash file layout", async () => {
    setupFixture(
      root,
      {
        buildId: "build-011",
        trailingSlash: true,
        routes: [{ route: "/about", status: "rendered", revalidate: false, router: "app" }],
      },
      {
        "about/index.html": "<html>About with trailing slash</html>",
        "about.rsc": "rsc-about",
      },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);
  });

  // ── API interaction ───────────────────────────────────────────────────────

  it("sends correct auth headers to Cloudflare API", async () => {
    setupFixture(
      root,
      {
        buildId: "build-012",
        routes: [{ route: "/test", status: "rendered", revalidate: false, router: "app" }],
      },
      { "test.html": "<html>Test</html>" },
    );

    await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });

    expect(fetchMock.calls[0].headers.Authorization).toBe(`Bearer ${TEST_OPTIONS.apiToken}`);
    expect(fetchMock.calls[0].headers["Content-Type"]).toBe("application/json");
    expect(fetchMock.calls[0].url).toContain(TEST_OPTIONS.accountId);
    expect(fetchMock.calls[0].url).toContain(TEST_OPTIONS.namespaceId);
  });

  it("throws on API failure", async () => {
    fetchMock.restore();
    const failMock = mockFetchFailure(500, "Internal Server Error");

    setupFixture(
      root,
      {
        buildId: "build-013",
        routes: [{ route: "/fail", status: "rendered", revalidate: false, router: "app" }],
      },
      { "fail.html": "<html>Fail</html>" },
    );

    await expect(seedKVCacheFromPrerender({ root, ...TEST_OPTIONS })).rejects.toThrow(
      "KV bulk upload failed",
    );

    failMock.restore();
  });
});

describe("uploadBulkToKV", () => {
  let fetchMock: ReturnType<typeof mockFetchSuccess>;

  beforeEach(() => {
    fetchMock = mockFetchSuccess();
  });

  afterEach(() => {
    fetchMock.restore();
  });

  it("uploads all pairs in a single batch when under limit", async () => {
    const pairs = Array.from({ length: 5 }, (_, i) => ({
      key: `key-${i}`,
      value: `value-${i}`,
      expiration_ttl: 3600,
    }));

    await uploadBulkToKV(pairs, "ns-id", "acct-id", "token");

    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0].body).toHaveLength(5);
  });

  it("splits into multiple batches when over 10,000 pairs", async () => {
    const pairs = Array.from({ length: 10_001 }, (_, i) => ({
      key: `key-${i}`,
      value: `value-${i}`,
    }));

    await uploadBulkToKV(pairs, "ns-id", "acct-id", "token");

    expect(fetchMock.calls).toHaveLength(2);
    expect(fetchMock.calls[0].body).toHaveLength(10_000);
    expect(fetchMock.calls[1].body).toHaveLength(1);
  });

  it("preserves key order across batch boundaries", async () => {
    const pairs = Array.from({ length: 10_001 }, (_, i) => ({
      key: `key-${i}`,
      value: `value-${i}`,
    }));

    await uploadBulkToKV(pairs, "ns-id", "acct-id", "token");

    const firstBatch = fetchMock.calls[0].body as Array<{ key: string }>;
    expect(firstBatch[0].key).toBe("key-0");
    expect(firstBatch[9999].key).toBe("key-9999");

    const secondBatch = fetchMock.calls[1].body as Array<{ key: string }>;
    expect(secondBatch[0].key).toBe("key-10000");
  });

  it("throws when API returns 200 but success:false", async () => {
    fetchMock.restore();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ message: "namespace not found" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof fetch;

    await expect(
      uploadBulkToKV([{ key: "k", value: "v" }], "ns-id", "acct-id", "token"),
    ).rejects.toThrow("KV bulk upload rejected");

    globalThis.fetch = originalFetch;
  });
});

// ─── Additional coverage tests ────────────────────────────────────────────────

describe("seedKVCacheFromPrerender — edge cases", () => {
  let root: string;
  let fetchMock: ReturnType<typeof mockFetchSuccess>;

  beforeEach(() => {
    root = createTempRoot();
    fetchMock = mockFetchSuccess();
  });

  afterEach(() => {
    fetchMock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses FNV1a hash for pathnames exceeding 200-char key threshold", async () => {
    const buildId = "build-hash";
    const longSlug = "a".repeat(190);
    const pathname = `/blog/${longSlug}`;
    setupFixture(
      root,
      {
        buildId,
        routes: [{ route: pathname, status: "rendered", revalidate: false, router: "app" }],
      },
      { [`blog/${longSlug}.html`]: "<html>Long path</html>" },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);

    const pairs = fetchMock.calls[0].body as Array<{ key: string }>;
    const expectedBaseKey = isrCacheKey("app", pathname, buildId);
    expect(expectedBaseKey).toContain("__hash:");
    expect(pairs[0].key).toBe(`cache:${expectedBaseKey}:html`);
  });

  it("correctly base64-encodes binary RSC content", async () => {
    const binaryRsc = Buffer.from([0x00, 0x80, 0xfe, 0xff, 0x01, 0x02, 0x7f, 0xc0]);
    setupFixture(
      root,
      {
        buildId: "build-bin",
        routes: [{ route: "/bin", status: "rendered", revalidate: false, router: "app" }],
      },
      {
        "bin.html": "<html>Binary</html>",
        "bin.rsc": binaryRsc,
      },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.kvPairsUploaded).toBe(2);

    const pairs = fetchMock.calls[0].body as Array<{ value: string }>;
    const rscEntry = JSON.parse(pairs[1].value);
    expect(Buffer.from(rscEntry.value.rscData, "base64")).toEqual(binaryRsc);
  });

  it("treats revalidate=0 as static (null revalidateAt, no TTL)", async () => {
    setupFixture(
      root,
      {
        buildId: "build-r0",
        routes: [{ route: "/r0", status: "rendered", revalidate: 0, router: "app" }],
      },
      { "r0.html": "<html/>" },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);

    const pairs = fetchMock.calls[0].body as Array<{ value: string; expiration_ttl?: number }>;
    const entry = JSON.parse(pairs[0].value);
    expect(entry.revalidateAt).toBeNull();
    expect(pairs[0].expiration_ttl).toBeUndefined();
  });

  it("clamps very small revalidate to MIN_KV_TTL (60s)", async () => {
    setupFixture(
      root,
      {
        buildId: "build-r1",
        routes: [{ route: "/r1", status: "rendered", revalidate: 1, router: "app" }],
      },
      { "r1.html": "<html/>" },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);

    const pairs = fetchMock.calls[0].body as Array<{ expiration_ttl?: number }>;
    // 1 * 10 = 10, clamped to 60
    expect(pairs[0].expiration_ttl).toBe(60);
  });

  it("handles unicode pathnames", async () => {
    setupFixture(
      root,
      {
        buildId: "build-uni",
        routes: [{ route: "/blog/日本語", status: "rendered", revalidate: false, router: "app" }],
      },
      {
        "blog/日本語.html": "<html>Japanese</html>",
        "blog/日本語.rsc": "rsc-jp",
      },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);

    const pairs = fetchMock.calls[0].body as Array<{ key: string }>;
    const expectedBaseKey = isrCacheKey("app", "/blog/日本語", "build-uni");
    expect(pairs[0].key).toBe(`cache:${expectedBaseKey}:html`);
  });

  it("seeds empty HTML file without error", async () => {
    setupFixture(
      root,
      {
        buildId: "build-empty",
        routes: [{ route: "/empty", status: "rendered", revalidate: false, router: "app" }],
      },
      { "empty.html": "" },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(1);

    const pairs = fetchMock.calls[0].body as Array<{ value: string }>;
    const entry = JSON.parse(pairs[0].value);
    expect(entry.value.html).toBe("");
  });

  it("seeds only App Router rendered routes from mixed manifest", async () => {
    setupFixture(
      root,
      {
        buildId: "build-mix",
        routes: [
          { route: "/app-page", status: "rendered", revalidate: 60, router: "app" },
          { route: "/pages-page", status: "rendered", revalidate: false, router: "pages" },
          { route: "/skipped", status: "skipped", reason: "ssr" },
          { route: "/errored", status: "error", error: "boom" },
          { route: "/app-static", status: "rendered", revalidate: false, router: "app" },
        ],
      },
      {
        "app-page.html": "<html>App</html>",
        "app-page.rsc": "rsc-app",
        "pages-page.html": "<html>Pages</html>",
        "app-static.html": "<html>Static App</html>",
      },
    );

    const result = await seedKVCacheFromPrerender({ root, ...TEST_OPTIONS });
    expect(result.seededRoutes).toBe(2); // only the 2 app router rendered routes
    expect(result.kvPairsUploaded).toBe(3); // app-page html + rsc, app-static html only
  });
});
