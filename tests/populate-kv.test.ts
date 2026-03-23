/**
 * Tests for deploy-time KV population.
 *
 * Verifies key construction, tag generation, entry serialization,
 * bulk upload batching, and end-to-end populate flow.
 *
 * Key parity tests ensure the deploy-time module produces keys and tags
 * identical to the runtime functions in entries/app-rsc-entry.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fnv1a64 } from "../packages/vinext/src/utils/hash.js";
import {
  appPageCacheKey,
  buildPageTags,
  buildKVCacheEntryJSON,
  buildRouteEntries,
  uploadBulkToKV,
  populateKV,
  ENTRY_PREFIX,
  KV_TTL_SECONDS,
  type KVBulkPair,
} from "../packages/vinext/src/cloudflare/populate-kv.js";

/** Extract and parse the JSON body from a mocked fetch RequestInit. */
function parseFetchBody(init: RequestInit | undefined): KVBulkPair[] {
  if (typeof init?.body !== "string") throw new Error("expected string body in fetch mock");
  return JSON.parse(init.body);
}

// ─── appPageCacheKey ────────────────────────────────────────────────────

describe("appPageCacheKey", () => {
  it("produces correct key for root path with buildId", () => {
    expect(appPageCacheKey("/", "html", "abc123")).toBe("app:abc123:/:html");
  });

  it("produces correct key for nested path with buildId", () => {
    expect(appPageCacheKey("/blog/hello", "rsc", "abc123")).toBe("app:abc123:/blog/hello:rsc");
  });

  it("strips trailing slash from non-root paths", () => {
    expect(appPageCacheKey("/blog/hello/", "html", "abc123")).toBe("app:abc123:/blog/hello:html");
  });

  it("preserves root / without stripping", () => {
    expect(appPageCacheKey("/", "rsc", "build1")).toBe("app:build1:/:rsc");
  });

  it("produces key without buildId when omitted", () => {
    expect(appPageCacheKey("/about", "html")).toBe("app:/about:html");
  });

  it("supports route suffix", () => {
    expect(appPageCacheKey("/api/data", "route", "b1")).toBe("app:b1:/api/data:route");
  });

  it("hashes long pathnames that exceed 200 char key limit", () => {
    const longPath = "/" + "a".repeat(250);
    const key = appPageCacheKey(longPath, "html", "b1");

    // Key must use __hash: format
    expect(key).toMatch(/^app:b1:__hash:.+:html$/);
    // Must contain fnv1a64 hash of the normalized pathname
    expect(key).toContain(fnv1a64(longPath));
    // Must be under 200 chars
    expect(key.length).toBeLessThanOrEqual(200);
  });

  it("produces deterministic hash for the same long pathname", () => {
    const longPath = "/" + "x".repeat(300);
    const key1 = appPageCacheKey(longPath, "html", "b1");
    const key2 = appPageCacheKey(longPath, "html", "b1");
    expect(key1).toBe(key2);
  });

  it("produces different keys for html and rsc suffixes on same path", () => {
    const htmlKey = appPageCacheKey("/page", "html", "b1");
    const rscKey = appPageCacheKey("/page", "rsc", "b1");
    expect(htmlKey).not.toBe(rscKey);
    expect(htmlKey).toBe("app:b1:/page:html");
    expect(rscKey).toBe("app:b1:/page:rsc");
  });
});

// ─── buildPageTags ──────────────────────────────────────────────────────

describe("buildPageTags", () => {
  it("produces correct tags for root path", () => {
    // Matches __pageCacheTags("/") from app-rsc-entry.ts
    const tags = buildPageTags("/");
    expect(tags).toContain("/");
    expect(tags).toContain("_N_T_/");
    expect(tags).toContain("_N_T_/layout");
    // Root has no intermediate segments, leaf page tag is _N_T_/page
    expect(tags).toContain("_N_T_/page");
  });

  it("produces correct tags for single-segment path", () => {
    const tags = buildPageTags("/about");
    expect(tags).toEqual([
      "/about",
      "_N_T_/about",
      "_N_T_/layout",
      "_N_T_/about/layout",
      "_N_T_/about/page",
    ]);
  });

  it("produces correct tags for nested path", () => {
    const tags = buildPageTags("/blog/hello");
    expect(tags).toEqual([
      "/blog/hello",
      "_N_T_/blog/hello",
      "_N_T_/layout",
      "_N_T_/blog/layout",
      "_N_T_/blog/hello/layout",
      "_N_T_/blog/hello/page",
    ]);
  });

  it("produces correct tags for deeply nested path", () => {
    const tags = buildPageTags("/a/b/c/d");
    expect(tags).toEqual([
      "/a/b/c/d",
      "_N_T_/a/b/c/d",
      "_N_T_/layout",
      "_N_T_/a/layout",
      "_N_T_/a/b/layout",
      "_N_T_/a/b/c/layout",
      "_N_T_/a/b/c/d/layout",
      "_N_T_/a/b/c/d/page",
    ]);
  });
});

// ─── buildKVCacheEntryJSON ──────────────────────────────────────────────

describe("buildKVCacheEntryJSON", () => {
  it("produces valid KVCacheEntry shape for HTML entry", () => {
    const json = buildKVCacheEntryJSON(
      { kind: "APP_PAGE", html: "<h1>Hello</h1>", status: 200 },
      ["/about"],
      60,
    );
    const entry = JSON.parse(json);

    expect(entry.value).toEqual({
      kind: "APP_PAGE",
      html: "<h1>Hello</h1>",
      rscData: undefined,
      headers: undefined,
      postponed: undefined,
      status: 200,
    });
    expect(entry.tags).toEqual(["/about"]);
    expect(typeof entry.lastModified).toBe("number");
    expect(entry.lastModified).toBeGreaterThan(0);
  });

  it("sets revalidateAt for ISR routes", () => {
    const before = Date.now();
    const json = buildKVCacheEntryJSON({ kind: "APP_PAGE", html: "", status: 200 }, [], 60);
    const after = Date.now();
    const entry = JSON.parse(json);

    // revalidateAt should be approximately now + 60 seconds
    expect(entry.revalidateAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(entry.revalidateAt).toBeLessThanOrEqual(after + 60_000);
  });

  it("sets revalidateAt to null for static routes", () => {
    const json = buildKVCacheEntryJSON({ kind: "APP_PAGE", html: "", status: 200 }, [], false);
    const entry = JSON.parse(json);
    expect(entry.revalidateAt).toBeNull();
  });

  it("base64-encodes rscData when present", () => {
    const rscBuffer = Buffer.from("RSC payload data");
    const json = buildKVCacheEntryJSON(
      {
        kind: "APP_PAGE",
        html: "",
        rscData: rscBuffer,
        status: 200,
      },
      [],
      60,
    );
    const entry = JSON.parse(json);

    expect(typeof entry.value.rscData).toBe("string");
    // Decode and verify round-trip
    const decoded = Buffer.from(entry.value.rscData, "base64").toString();
    expect(decoded).toBe("RSC payload data");
  });

  it("omits rscData from JSON when not provided", () => {
    const json = buildKVCacheEntryJSON(
      { kind: "APP_PAGE", html: "<p>test</p>", status: 200 },
      [],
      false,
    );
    const entry = JSON.parse(json);
    expect(entry.value.rscData).toBeUndefined();
  });
});

// ─── buildRouteEntries ──────────────────────────────────────────────────

describe("buildRouteEntries", () => {
  it("returns 2 pairs when rscBuffer is provided", () => {
    const pairs = buildRouteEntries(
      "/about",
      "<h1>About</h1>",
      Buffer.from("rsc-data"),
      60,
      "build1",
    );
    expect(pairs).toHaveLength(2);
  });

  it("returns 1 pair when rscBuffer is null", () => {
    const pairs = buildRouteEntries("/about", "<h1>About</h1>", null, 60, "build1");
    expect(pairs).toHaveLength(1);
  });

  it("produces correct KV keys with ENTRY_PREFIX", () => {
    const pairs = buildRouteEntries("/blog/hello", "<p>content</p>", Buffer.from("rsc"), 60, "b1");
    const htmlPair = pairs.find((p) => p.key.endsWith(":html"));
    const rscPair = pairs.find((p) => p.key.endsWith(":rsc"));

    expect(htmlPair).toBeDefined();
    expect(rscPair).toBeDefined();
    expect(htmlPair!.key).toBe(`${ENTRY_PREFIX}app:b1:/blog/hello:html`);
    expect(rscPair!.key).toBe(`${ENTRY_PREFIX}app:b1:/blog/hello:rsc`);
  });

  it("prepends appPrefix when provided", () => {
    const pairs = buildRouteEntries("/page", "<p>hi</p>", null, 60, "b1", "myapp");
    expect(pairs[0].key).toBe(`myapp:${ENTRY_PREFIX}app:b1:/page:html`);
  });

  it("sets expiration_ttl for ISR routes", () => {
    const pairs = buildRouteEntries("/page", "<p>hi</p>", null, 60, "b1");
    expect(pairs[0].expiration_ttl).toBe(KV_TTL_SECONDS);
  });

  it("omits expiration_ttl for static routes", () => {
    const pairs = buildRouteEntries("/page", "<p>hi</p>", null, false, "b1");
    expect(pairs[0].expiration_ttl).toBeUndefined();
  });

  it("html pair contains APP_PAGE value with html and no rscData", () => {
    const pairs = buildRouteEntries("/test", "<h1>Test</h1>", Buffer.from("rsc-payload"), 30, "b1");
    const htmlEntry = JSON.parse(pairs[0].value);
    expect(htmlEntry.value.kind).toBe("APP_PAGE");
    expect(htmlEntry.value.html).toBe("<h1>Test</h1>");
    expect(htmlEntry.value.rscData).toBeUndefined();
  });

  it("rsc pair contains APP_PAGE value with rscData and empty html", () => {
    const pairs = buildRouteEntries("/test", "<h1>Test</h1>", Buffer.from("rsc-payload"), 30, "b1");
    const rscEntry = JSON.parse(pairs[1].value);
    expect(rscEntry.value.kind).toBe("APP_PAGE");
    expect(rscEntry.value.html).toBe("");
    expect(typeof rscEntry.value.rscData).toBe("string");
    const decoded = Buffer.from(rscEntry.value.rscData, "base64").toString();
    expect(decoded).toBe("rsc-payload");
  });

  it("includes page tags in both entries", () => {
    const pairs = buildRouteEntries("/blog/post", "<p>post</p>", Buffer.from("rsc"), 60, "b1");
    const htmlEntry = JSON.parse(pairs[0].value);
    const rscEntry = JSON.parse(pairs[1].value);

    const expectedTags = buildPageTags("/blog/post");
    expect(htmlEntry.tags).toEqual(expectedTags);
    expect(rscEntry.tags).toEqual(expectedTags);
  });
});

// ─── uploadBulkToKV ─────────────────────────────────────────────────────

describe("uploadBulkToKV", () => {
  const baseArgs = {
    namespaceId: "ns-123",
    accountId: "acc-456",
    apiToken: "token-789",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a single batch for small payload", async () => {
    const pairs: KVBulkPair[] = [
      { key: "cache:app:b1:/:html", value: '{"value":{}}' },
      { key: "cache:app:b1:/:rsc", value: '{"value":{}}' },
    ];

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await uploadBulkToKV(pairs, baseArgs.namespaceId, baseArgs.accountId, baseArgs.apiToken);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain(
      `/accounts/${baseArgs.accountId}/storage/kv/namespaces/${baseArgs.namespaceId}/bulk`,
    );
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${baseArgs.apiToken}`,
      "Content-Type": "application/json",
    });

    // Body should be the pairs array
    const body = parseFetchBody(init);
    expect(body).toHaveLength(2);
    expect(body[0].key).toBe("cache:app:b1:/:html");
  });

  it("splits into multiple batches at 10,000 entries", async () => {
    const pairs: KVBulkPair[] = Array.from({ length: 15_000 }, (_, i) => ({
      key: `cache:app:b1:/page-${i}:html`,
      value: "{}",
    }));

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await uploadBulkToKV(pairs, baseArgs.namespaceId, baseArgs.accountId, baseArgs.apiToken);

    // 15,000 entries → 2 batches (10,000 + 5,000)
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const batch1 = parseFetchBody(fetchSpy.mock.calls[0][1]);
    const batch2 = parseFetchBody(fetchSpy.mock.calls[1][1]);
    expect(batch1).toHaveLength(10_000);
    expect(batch2).toHaveLength(5_000);
  });

  it("throws on API error with descriptive message", async () => {
    const pairs: KVBulkPair[] = [{ key: "test", value: "{}" }];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    await expect(
      uploadBulkToKV(pairs, baseArgs.namespaceId, baseArgs.accountId, baseArgs.apiToken),
    ).rejects.toThrow(/401/);
  });
});

// ─── populateKV ─────────────────────────────────────────────────────────

describe("populateKV", () => {
  let tmpDir: string;
  let serverDir: string;
  let prerenderDir: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "populate-kv-test-"));
    serverDir = path.join(tmpDir, "dist", "server");
    prerenderDir = path.join(serverDir, "prerendered-routes");
    fs.mkdirSync(prerenderDir, { recursive: true });
  });

  function writeManifest(manifest: Record<string, unknown>) {
    fs.writeFileSync(path.join(serverDir, "vinext-prerender.json"), JSON.stringify(manifest));
  }

  function writeHtml(filePath: string, content: string) {
    const full = path.join(prerenderDir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function writeRsc(filePath: string, content: string) {
    const full = path.join(prerenderDir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it("reads manifest and files, produces correct upload payload", async () => {
    writeManifest({
      buildId: "b1",
      trailingSlash: false,
      routes: [{ route: "/about", status: "rendered", revalidate: 60 }],
    });
    writeHtml("about.html", "<h1>About</h1>");
    writeRsc("about.rsc", "rsc-about-data");

    const uploadedPairs: KVBulkPair[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = parseFetchBody(init);
      uploadedPairs.push(...body);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const result = await populateKV({
      root: tmpDir,
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "tok",
    });

    expect(result.routesProcessed).toBe(1);
    expect(result.entriesUploaded).toBe(2); // html + rsc
    expect(uploadedPairs).toHaveLength(2);

    // Verify keys
    expect(uploadedPairs[0].key).toBe("cache:app:b1:/about:html");
    expect(uploadedPairs[1].key).toBe("cache:app:b1:/about:rsc");

    // Verify HTML entry content
    const htmlEntry = JSON.parse(uploadedPairs[0].value);
    expect(htmlEntry.value.html).toBe("<h1>About</h1>");
    expect(htmlEntry.value.kind).toBe("APP_PAGE");
    expect(htmlEntry.tags).toEqual(buildPageTags("/about"));
  });

  it("skips routes with status !== rendered", async () => {
    writeManifest({
      buildId: "b1",
      trailingSlash: false,
      routes: [
        { route: "/dynamic/[id]", status: "skipped", reason: "dynamic" },
        { route: "/about", status: "rendered", revalidate: 60 },
      ],
    });
    writeHtml("about.html", "<h1>About</h1>");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const result = await populateKV({
      root: tmpDir,
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "tok",
    });

    expect(result.routesProcessed).toBe(1);
    // Only html since no .rsc file
    expect(result.entriesUploaded).toBe(1);
  });

  it("skips routes with missing HTML file", async () => {
    writeManifest({
      buildId: "b1",
      trailingSlash: false,
      routes: [{ route: "/ghost", status: "rendered", revalidate: 60 }],
    });
    // No HTML or RSC files written

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    const result = await populateKV({
      root: tmpDir,
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "tok",
    });

    expect(result.routesProcessed).toBe(0);
    expect(result.entriesUploaded).toBe(0);
    // Should not have called the API
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("seeds RSC when .rsc file exists, skips when missing", async () => {
    writeManifest({
      buildId: "b1",
      trailingSlash: false,
      routes: [
        { route: "/with-rsc", status: "rendered", revalidate: 30 },
        { route: "/no-rsc", status: "rendered", revalidate: 30 },
      ],
    });
    writeHtml("with-rsc.html", "<p>with rsc</p>");
    writeRsc("with-rsc.rsc", "rsc-data");
    writeHtml("no-rsc.html", "<p>no rsc</p>");
    // Intentionally no .rsc file for /no-rsc

    const uploadedPairs: KVBulkPair[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = parseFetchBody(init);
      uploadedPairs.push(...body);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const result = await populateKV({
      root: tmpDir,
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "tok",
    });

    expect(result.routesProcessed).toBe(2);
    expect(result.entriesUploaded).toBe(3); // 2 for with-rsc + 1 for no-rsc
  });

  it("uses path (not route) for dynamic routes", async () => {
    writeManifest({
      buildId: "b1",
      trailingSlash: false,
      routes: [{ route: "/blog/[slug]", status: "rendered", revalidate: 60, path: "/blog/hello" }],
    });
    writeHtml("blog/hello.html", "<p>Hello post</p>");
    writeRsc("blog/hello.rsc", "rsc-hello");

    const uploadedPairs: KVBulkPair[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = parseFetchBody(init);
      uploadedPairs.push(...body);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    await populateKV({
      root: tmpDir,
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "tok",
    });

    // Should use /blog/hello (concrete path), not /blog/[slug] (pattern)
    expect(uploadedPairs[0].key).toBe("cache:app:b1:/blog/hello:html");
    expect(uploadedPairs[1].key).toBe("cache:app:b1:/blog/hello:rsc");
  });

  it("returns skipped when manifest is missing", async () => {
    // No manifest written
    const result = await populateKV({
      root: tmpDir,
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "tok",
    });

    expect(result.skipped).toBeDefined();
    expect(result.routesProcessed).toBe(0);
    expect(result.entriesUploaded).toBe(0);
  });

  it("returns skipped when manifest has no buildId", async () => {
    writeManifest({
      routes: [{ route: "/about", status: "rendered", revalidate: 60 }],
    });

    const result = await populateKV({
      root: tmpDir,
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "tok",
    });

    expect(result.skipped).toBeDefined();
  });

  it("handles index route with trailingSlash", async () => {
    writeManifest({
      buildId: "b1",
      trailingSlash: true,
      routes: [{ route: "/about", status: "rendered", revalidate: 60 }],
    });
    // With trailingSlash, getOutputPath produces about/index.html
    writeHtml("about/index.html", "<h1>About</h1>");
    writeRsc("about.rsc", "rsc-data");

    const uploadedPairs: KVBulkPair[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = parseFetchBody(init);
      uploadedPairs.push(...body);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const result = await populateKV({
      root: tmpDir,
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "tok",
    });

    expect(result.routesProcessed).toBe(1);
    expect(uploadedPairs[0].key).toBe("cache:app:b1:/about:html");
  });
});
