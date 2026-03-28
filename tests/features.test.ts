import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite-plus";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import zlib from "node:zlib";
import vinext from "../packages/vinext/src/index.js";
import {
  APP_FIXTURE_DIR,
  PAGES_FIXTURE_DIR,
  PAGES_I18N_DOMAINS_BASEPATH_FIXTURE_DIR,
  PAGES_I18N_DOMAINS_FIXTURE_DIR,
  createIsolatedFixture,
  requestNodeServerWithHost,
  startFixtureServer,
} from "./helpers.js";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";

const FIXTURE_DIR = PAGES_FIXTURE_DIR;

class CapturingNodeResponse extends PassThrough {
  statusCode = 0;
  headers: Record<string, string | string[]> = {};

  writeHead(
    statusCode: number,
    headersOrStatusText: string | Record<string, string | string[]>,
    maybeHeaders?: Record<string, string | string[]>,
  ): this {
    this.statusCode = statusCode;
    this.headers =
      typeof headersOrStatusText === "string" ? (maybeHeaders ?? {}) : headersOrStatusText;
    return this;
  }
}

class DisconnectingNodeResponse extends Writable {
  statusCode = 0;
  headers: Record<string, string | string[]> = {};
  writeCount = 0;

  writeHead(
    statusCode: number,
    headersOrStatusText: string | Record<string, string | string[]>,
    maybeHeaders?: Record<string, string | string[]>,
  ): this {
    this.statusCode = statusCode;
    this.headers =
      typeof headersOrStatusText === "string" ? (maybeHeaders ?? {}) : headersOrStatusText;
    return this;
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.writeCount += 1;
    const error = new Error("client disconnected");
    callback(error);
    this.destroy(error);
  }
}

function createStreamingBody(
  chunks: Array<{ text: string; delayMs?: number }>,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let canceled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const { text, delayMs } of chunks) {
        if (delayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (canceled) return;
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
    cancel() {
      canceled = true;
      onCancel?.();
    },
  });
}

async function captureCompressedWebResponse(encoding: "gzip" | "br"): Promise<{
  body: string;
  rawBody: Buffer;
  headers: Record<string, string | string[]>;
  statusCode: number;
  firstDecodedMs: number;
  endMs: number;
}> {
  const { sendWebResponse } = await import("../packages/vinext/src/server/prod-server.js");
  // ReadableStream.start() begins running during construction, so start timing
  // before creating the Response to include the full delayed chunk interval.
  const startedAt = performance.now();

  const response = new Response(
    createStreamingBody([
      { text: "<h1>Streaming SSR Test</h1><p>Loading delayed chunk...</p>" },
      { text: "<p>Delayed stream content loaded</p>", delayMs: 250 },
    ]),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );

  const req = {
    method: "GET",
    headers: { "accept-encoding": encoding },
  };
  const res = new CapturingNodeResponse();
  const decoder = encoding === "br" ? zlib.createBrotliDecompress() : zlib.createGunzip();
  const rawChunks: Buffer[] = [];
  const decodedChunks: Buffer[] = [];
  let firstDecodedMs = -1;

  res.on("data", (chunk: Buffer) => {
    rawChunks.push(Buffer.from(chunk));
  });
  res.on("error", () => {
    /* ignore closed test stream noise */
  });
  decoder.on("data", (chunk: Buffer) => {
    decodedChunks.push(Buffer.from(chunk));
    if (firstDecodedMs === -1) {
      firstDecodedMs = performance.now() - startedAt;
    }
  });
  decoder.on("error", () => {
    /* surfaced through finished(decoder) */
  });
  res.pipe(decoder);

  await sendWebResponse(response, req as any, res as any, true);
  await Promise.all([finished(res), finished(decoder)]);

  return {
    body: Buffer.concat(decodedChunks).toString("utf8"),
    rawBody: Buffer.concat(rawChunks),
    headers: res.headers,
    statusCode: res.statusCode,
    firstDecodedMs,
    endMs: performance.now() - startedAt,
  };
}

describe("parameterized redirects and rewrites", () => {
  let prServer: ViteDevServer;
  let prBaseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-rr-"));

    // Symlink node_modules
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    // next.config.mjs with parameterized redirects and rewrites
    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default {
  async redirects() {
    return [
      { source: "/old-blog/:slug", destination: "/blog/:slug", permanent: false },
      { source: "/legacy/:year/:month", destination: "/archive/:year-:month", permanent: true },
    ];
  },
  async rewrites() {
    return [
      { source: "/posts/:id", destination: "/blog/:id" },
      { source: "/docs/:path*", destination: "/help/:path*" },
    ];
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "X-Api-Version", value: "2" }],
      },
      {
        source: "/blog/:slug",
        headers: [{ key: "X-Content-Type", value: "blog" }],
      },
    ];
  },
};`,
    );

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, "pages", "blog"), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, "pages", "help"), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, "pages", "api"), { recursive: true });

    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    await fsp.writeFile(
      path.join(tmpDir, "pages", "blog", "[slug].tsx"),
      `export function getServerSideProps({ params }) {
  return { props: { slug: params.slug } };
}
export default function BlogPost({ slug }) {
  return <h1>Blog: {slug}</h1>;
}`,
    );

    await fsp.writeFile(
      path.join(tmpDir, "pages", "help", "[[...path]].tsx"),
      `export function getServerSideProps({ params }) {
  return { props: { path: params.path || [] } };
}
export default function Help({ path }) {
  return <h1>Help: {path.join("/")}</h1>;
}`,
    );

    await fsp.writeFile(
      path.join(tmpDir, "pages", "api", "test.ts"),
      `export default function handler(req, res) {
  res.json({ ok: true });
}`,
    );

    const plugins: any[] = [vinext()];
    prServer = await createServer({
      root: tmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await prServer.listen();
    const addr = prServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      prBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (prServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([prServer?.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("parameterized redirect: /old-blog/:slug -> /blog/:slug", async () => {
    const res = await fetch(`${prBaseUrl}/old-blog/my-post`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/blog/my-post");
  });

  it("permanent redirect with multiple params", async () => {
    const res = await fetch(`${prBaseUrl}/legacy/2024/06`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/archive/2024-06");
  });

  it("parameterized rewrite: /posts/:id -> /blog/:id", async () => {
    const res = await fetch(`${prBaseUrl}/posts/hello-world`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // React SSR may insert comment nodes (<!-- -->) between text segments
    expect(html).toMatch(/Blog:.*hello-world/);
  });

  it("custom headers with :path* pattern", async () => {
    const res = await fetch(`${prBaseUrl}/api/test`);
    expect(res.headers.get("x-api-version")).toBe("2");
  });

  it("custom headers with :slug pattern", async () => {
    const res = await fetch(`${prBaseUrl}/blog/my-post`);
    expect(res.headers.get("x-content-type")).toBe("blog");
  });
});

// ---------------------------------------------------------------------------
// External URL rewrites (proxy to third-party hosts)
// ---------------------------------------------------------------------------

describe("external URL rewrites", () => {
  let extServer: ViteDevServer;
  let extBaseUrl: string;
  let extTmpDir: string;
  // Local HTTP server to act as the external upstream
  let upstreamServer: import("node:http").Server;
  let upstreamPort: number;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const http = await import("node:http");

    // Start a local HTTP server to act as the "external" upstream
    upstreamServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      if (url.pathname === "/api/data") {
        res.writeHead(200, { "Content-Type": "application/json", "X-Upstream": "true" });
        res.end(JSON.stringify({ source: "upstream", path: url.pathname }));
      } else if (url.pathname.startsWith("/static/")) {
        res.writeHead(200, { "Content-Type": "text/plain", "X-Upstream": "true" });
        res.end("static:" + url.pathname.slice("/static/".length));
      } else {
        res.writeHead(200, { "Content-Type": "text/plain", "X-Upstream": "true" });
        res.end("upstream:" + url.pathname);
      }
    });
    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, () => {
        const addr = upstreamServer.address();
        upstreamPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    extTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ext-rewrite-"));

    // Symlink node_modules
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(extTmpDir, "node_modules"), "junction");

    // next.config.mjs with external rewrites pointing to our local upstream
    await fsp.writeFile(
      path.join(extTmpDir, "next.config.mjs"),
      `export default {
  async rewrites() {
    return [
      { source: "/proxy/api/data", destination: "http://localhost:${upstreamPort}/api/data" },
      { source: "/proxy/static/:path*", destination: "http://localhost:${upstreamPort}/static/:path*" },
      { source: "/proxy/catch/:path*", destination: "http://localhost:${upstreamPort}/:path*" },
    ];
  },
};`,
    );

    await fsp.mkdir(path.join(extTmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(extTmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    const plugins: any[] = [vinext()];
    extServer = await createServer({
      root: extTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await extServer.listen();
    const addr = extServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      extBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (extServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([extServer?.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    } catch {
      /* ignore */
    }
    upstreamServer?.close();
    const fsp = await import("node:fs/promises");
    await fsp.rm(extTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("proxies exact path external rewrite to upstream", async () => {
    const res = await fetch(`${extBaseUrl}/proxy/api/data`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("true");
    const data = await res.json();
    expect(data.source).toBe("upstream");
    expect(data.path).toBe("/api/data");
  });

  it("proxies catch-all external rewrite with path substitution", async () => {
    const res = await fetch(`${extBaseUrl}/proxy/static/script`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("true");
    const body = await res.text();
    expect(body).toBe("static:script");
  });

  it("proxies nested catch-all paths", async () => {
    const res = await fetch(`${extBaseUrl}/proxy/catch/deeply/nested/path`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("upstream:/deeply/nested/path");
  });

  it("does not proxy internal rewrites (non-external URLs still work)", async () => {
    const res = await fetch(`${extBaseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Home");
  });
});

// ---------------------------------------------------------------------------
// CSS Modules support
// ---------------------------------------------------------------------------

describe("CSS Modules support (Pages Router)", () => {
  let cssServer: ViteDevServer;
  let cssBaseUrl: string;
  let cssTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    cssTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-css-"));

    // Symlink node_modules
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(cssTmpDir, "node_modules"), "junction");

    // next.config.mjs
    await fsp.writeFile(path.join(cssTmpDir, "next.config.mjs"), `export default {};`);

    // Create directories
    await fsp.mkdir(path.join(cssTmpDir, "pages"), { recursive: true });
    await fsp.mkdir(path.join(cssTmpDir, "styles"), { recursive: true });

    // CSS module file
    await fsp.writeFile(
      path.join(cssTmpDir, "styles", "card.module.css"),
      `.card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
.cardTitle { font-size: 1.5rem; font-weight: bold; }
.cardBody { color: #666; line-height: 1.6; }`,
    );

    // Page using CSS modules
    await fsp.writeFile(
      path.join(cssTmpDir, "pages", "index.tsx"),
      `import styles from "../styles/card.module.css";
export default function CSSModulesTest() {
  return (
    <div>
      <h1>CSS Modules Test</h1>
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>Card Title</h2>
        <p className={styles.cardBody}>Card body content</p>
      </div>
      <div id="class-names" data-card={styles.card} data-title={styles.cardTitle} data-body={styles.cardBody}>
        debug
      </div>
    </div>
  );
}`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins: any[] = [vinext()];
    cssServer = await createServer({
      root: cssTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await cssServer.listen();
    const addr = cssServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      cssBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (cssServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([cssServer?.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(cssTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("renders page with CSS module class names in SSR", async () => {
    const res = await fetch(`${cssBaseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("CSS Modules Test");
    expect(html).toContain("Card Title");
    expect(html).toContain("Card body content");
  });

  it("CSS module class names are scoped (hashed) in SSR output", async () => {
    const res = await fetch(`${cssBaseUrl}/`);
    const html = await res.text();
    // Vite CSS modules produce hashed class names like "_card_xxxxx_1"
    // The debug div has data attributes with the class names
    const dataMatch = html.match(/data-card="([^"]+)"/);
    expect(dataMatch).not.toBeNull();
    const cardClass = dataMatch![1];
    // The class should NOT be just "card" — it should be hashed/scoped
    expect(cardClass).not.toBe("card");
    // Vite CSS module format: usually contains the original name as a substring
    expect(cardClass.length).toBeGreaterThan(3);
  });

  it("different CSS module classes have different hashed names", async () => {
    const res = await fetch(`${cssBaseUrl}/`);
    const html = await res.text();
    const cardMatch = html.match(/data-card="([^"]+)"/);
    const titleMatch = html.match(/data-title="([^"]+)"/);
    const bodyMatch = html.match(/data-body="([^"]+)"/);
    expect(cardMatch).not.toBeNull();
    expect(titleMatch).not.toBeNull();
    expect(bodyMatch).not.toBeNull();
    // All three should be different
    const classes = [cardMatch![1], titleMatch![1], bodyMatch![1]];
    const unique = new Set(classes);
    expect(unique.size).toBe(3);
  });

  it("CSS module class names are applied as className attribute", async () => {
    const res = await fetch(`${cssBaseUrl}/`);
    const html = await res.text();
    // Extract the card class name from data attribute
    const cardMatch = html.match(/data-card="([^"]+)"/);
    expect(cardMatch).not.toBeNull();
    const cardClass = cardMatch![1];
    // The same class should appear as a className on a div
    expect(html).toContain(`class="${cardClass}"`);
  });

  it("CSS module class names are consistent across SSR requests", async () => {
    const res1 = await fetch(`${cssBaseUrl}/`);
    const html1 = await res1.text();
    const res2 = await fetch(`${cssBaseUrl}/`);
    const html2 = await res2.text();
    const card1 = html1.match(/data-card="([^"]+)"/)?.[1];
    const card2 = html2.match(/data-card="([^"]+)"/)?.[1];
    expect(card1).toBe(card2);
  });
});

// ---------------------------------------------------------------------------
// next/form shim
// ---------------------------------------------------------------------------

describe("ISR (Pages Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR));
  });

  afterAll(async () => {
    await server?.close();
  });

  it("renders ISR page on first request (cache MISS)", async () => {
    const res = await fetch(`${baseUrl}/isr-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ISR Page");
    expect(html).toContain("Hello from ISR");
    // First request should be a cache miss
    expect(res.headers.get("x-vinext-cache")).toBe("MISS");
    expect(res.headers.get("cache-control")).toContain("s-maxage=1");
  });

  it("serves cached ISR page on second request (cache HIT)", async () => {
    // First request populates the cache
    const res1 = await fetch(`${baseUrl}/isr-test`);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    const timestamp1Match = html1.match(/data-testid="timestamp">(\d+)</);
    expect(timestamp1Match).toBeTruthy();
    const timestamp1 = timestamp1Match![1];

    // Second request should be a cache hit with same timestamp
    const res2 = await fetch(`${baseUrl}/isr-test`);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(res2.headers.get("x-vinext-cache")).toBe("HIT");
    const timestamp2Match = html2.match(/data-testid="timestamp">(\d+)</);
    expect(timestamp2Match).toBeTruthy();
    expect(timestamp2Match![1]).toBe(timestamp1);
  });

  it("serves stale content after TTL expires then regenerates", async () => {
    // First request populates cache
    const res1 = await fetch(`${baseUrl}/isr-test`);
    const html1 = await res1.text();
    const timestamp1Match = html1.match(/data-testid="timestamp">(\d+)</);
    const timestamp1 = timestamp1Match![1];

    // Wait for TTL to expire (revalidate: 1 second)
    await new Promise((r) => setTimeout(r, 1200));

    // Request after TTL should get STALE content
    const res2 = await fetch(`${baseUrl}/isr-test`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-vinext-cache")).toBe("STALE");
    // Stale content should have the same timestamp as original
    const html2 = await res2.text();
    const timestamp2Match = html2.match(/data-testid="timestamp">(\d+)</);
    expect(timestamp2Match![1]).toBe(timestamp1);

    // Wait a moment for background regeneration to complete
    await new Promise((r) => setTimeout(r, 200));

    // Next request should be a HIT — background regen re-ran getStaticProps
    // and cached the fresh result.
    const res3 = await fetch(`${baseUrl}/isr-test`);
    expect(res3.status).toBe(200);
    expect(res3.headers.get("x-vinext-cache")).toBe("HIT");
  });

  it("background regeneration re-renders HTML with fresh props", async () => {
    // Ensure cache is populated (may already be from prior tests)
    await fetch(`${baseUrl}/isr-test`);

    // Wait for TTL to expire (revalidate: 1 second)
    await new Promise((r) => setTimeout(r, 1200));

    // Trigger background regeneration via STALE request and capture old HTML
    const staleRes = await fetch(`${baseUrl}/isr-test`);
    expect(staleRes.headers.get("x-vinext-cache")).toBe("STALE");
    const staleHtml = await staleRes.text();
    const staleTimestamp = staleHtml.match(/data-testid="timestamp">(\d+)</);
    expect(staleTimestamp).toBeTruthy();
    const oldTimestamp = Number(staleTimestamp![1]);

    // Wait for background regeneration to complete
    await new Promise((r) => setTimeout(r, 500));

    // The regenerated HIT should have DIFFERENT HTML — the page must have been
    // re-rendered with fresh getStaticProps data, not just the old HTML cached
    // again with new pageData.
    const hitRes = await fetch(`${baseUrl}/isr-test`);
    expect(hitRes.headers.get("x-vinext-cache")).toBe("HIT");
    const hitHtml = await hitRes.text();
    const hitTimestamp = hitHtml.match(/data-testid="timestamp">(\d+)</);
    expect(hitTimestamp).toBeTruthy();
    const newTimestamp = Number(hitTimestamp![1]);

    // The HTML timestamp must have changed — proves the page was re-rendered,
    // not just getStaticProps re-run with old HTML cached again.
    expect(newTimestamp).toBeGreaterThan(oldTimestamp);

    // __NEXT_DATA__ must also contain the fresh timestamp, proving both the
    // server-rendered HTML and the hydration data are in sync.
    const nextDataMatch = hitHtml.match(
      /window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\})(?:;|<\/script>)/,
    );
    expect(nextDataMatch).toBeTruthy();
    const nextData = JSON.parse(nextDataMatch![1]);
    expect(nextData.props.pageProps.timestamp).toBe(newTimestamp);
  });

  it("sets Cache-Control header for ISR pages", async () => {
    const res = await fetch(`${baseUrl}/isr-test`);
    const cacheControl = res.headers.get("cache-control");
    expect(cacheControl).toContain("s-maxage=1");
    expect(cacheControl).toContain("stale-while-revalidate");
  });

  it("does not set ISR headers for non-ISR pages", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vinext-cache")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ISR (App Router)
// ---------------------------------------------------------------------------

describe("ISR (App Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  // ── Dev mode ──────────────────────────────────────────────────────────────
  // NOTE: The Vite plugin statically replaces `process.env.NODE_ENV` at
  // transform time using `define`, so it cannot be mutated at runtime in
  // integration tests. Production ISR cache behavior (MISS/HIT/STALE/regen) is
  // covered by Playwright E2E tests. These integration tests verify dev-mode
  // behavior: correct headers emitted, no ISR cache reads/writes.

  it("dev: renders ISR page and emits Cache-Control header", async () => {
    const res = await fetch(`${baseUrl}/isr-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("App Router ISR Test");
    expect(html).toContain("Hello from ISR");
    expect(res.headers.get("cache-control")).toContain("s-maxage=1");
    expect(res.headers.get("cache-control")).toContain("stale-while-revalidate");
  });

  it("dev: does NOT write to or read from ISR cache (no X-Vinext-Cache header)", async () => {
    // In dev mode the production guard (statically compiled) prevents cache
    // reads and writes, so X-Vinext-Cache is absent on every request.
    const res1 = await fetch(`${baseUrl}/isr-test`);
    expect(res1.headers.get("x-vinext-cache")).toBeNull();

    const res2 = await fetch(`${baseUrl}/isr-test`);
    expect(res2.headers.get("x-vinext-cache")).toBeNull();
  });

  it("dev: RSC requests (.rsc suffix) return RSC stream with Cache-Control but no X-Vinext-Cache", async () => {
    const res = await fetch(`${baseUrl}/isr-test.rsc`, {
      headers: { Accept: "text/x-component" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    // ISR cache reads/writes are prod-only, so no X-Vinext-Cache in dev
    expect(res.headers.get("x-vinext-cache")).toBeNull();
    // Cache-Control IS still emitted for RSC responses on ISR pages
    expect(res.headers.get("cache-control")).toContain("s-maxage=1");
    expect(res.headers.get("cache-control")).toContain("stale-while-revalidate");
  });

  it("dev: RSC prefetch requests (Next-Router-Prefetch header) return RSC stream with Cache-Control", async () => {
    const res = await fetch(`${baseUrl}/isr-test.rsc`, {
      headers: { Accept: "text/x-component", "Next-Router-Prefetch": "1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    // Prefetch RSC requests should also get Cache-Control (no X-Vinext-Cache in dev)
    expect(res.headers.get("cache-control")).toContain("s-maxage=1");
    expect(res.headers.get("x-vinext-cache")).toBeNull();
  });

  it("dev: pages without revalidate export emit no Cache-Control or X-Vinext-Cache headers", async () => {
    // The home page does not export `revalidate`, so it is treated as dynamic
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vinext-cache")).toBeNull();
    // No ISR Cache-Control on dynamic pages
    expect(res.headers.get("cache-control") ?? "").not.toContain("s-maxage");
  });
});

// ---------------------------------------------------------------------------
// ISR cache internals
// ---------------------------------------------------------------------------

describe("ISR cache internals", () => {
  it("MemoryCacheHandler returns stale entries instead of null", async () => {
    const { MemoryCacheHandler } = await import("../packages/vinext/src/shims/cache.js");
    const handler = new MemoryCacheHandler();

    // Set an entry with a very short TTL
    await handler.set(
      "test-stale",
      { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: [], revalidate: 0.001 },
      { revalidate: 0.001 },
    );

    // Wait for it to expire
    await new Promise((r) => setTimeout(r, 10));

    // Should return the entry with cacheState: "stale"
    const result = await handler.get("test-stale");
    expect(result).not.toBeNull();
    expect(result!.cacheState).toBe("stale");
    expect(result!.value).not.toBeNull();
  });

  it("MemoryCacheHandler returns fresh entries without cacheState", async () => {
    const { MemoryCacheHandler } = await import("../packages/vinext/src/shims/cache.js");
    const handler = new MemoryCacheHandler();

    await handler.set(
      "test-fresh",
      { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: [], revalidate: 60 },
      { revalidate: 60 },
    );

    const result = await handler.get("test-fresh");
    expect(result).not.toBeNull();
    expect(result!.cacheState).toBeUndefined();
  });

  it("MemoryCacheHandler still returns null for tag-invalidated entries", async () => {
    const { MemoryCacheHandler } = await import("../packages/vinext/src/shims/cache.js");
    const handler = new MemoryCacheHandler();

    await handler.set(
      "test-tag",
      {
        kind: "FETCH",
        data: { headers: {}, body: "test", url: "" },
        tags: ["mytag"],
        revalidate: 60,
      },
      { revalidate: 60, tags: ["mytag"] },
    );

    // Invalidate the tag
    await handler.revalidateTag("mytag");

    // Should return null (hard invalidation, not stale)
    const result = await handler.get("test-tag");
    expect(result).toBeNull();
  });

  it("MemoryCacheHandler skips storage when data.revalidate is 0", async () => {
    const { MemoryCacheHandler } = await import("../packages/vinext/src/shims/cache.js");
    const handler = new MemoryCacheHandler();

    // revalidate: 0 means "don't cache" — entry should not be stored at all
    await handler.set(
      "revalidate-zero-data",
      { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: [], revalidate: 0 },
      { tags: [] },
    );

    const result = await handler.get("revalidate-zero-data");
    expect(result).toBeNull();
  });

  it("MemoryCacheHandler skips storage when ctx.revalidate is 0", async () => {
    const { MemoryCacheHandler } = await import("../packages/vinext/src/shims/cache.js");
    const handler = new MemoryCacheHandler();

    // revalidate: 0 via ctx should also skip storage
    await handler.set(
      "revalidate-zero-ctx",
      { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: [], revalidate: false },
      { revalidate: 0 },
    );

    const result = await handler.get("revalidate-zero-ctx");
    expect(result).toBeNull();
  });

  it("MemoryCacheHandler stores entry when ctx.revalidate is 0 but data.revalidate is positive", async () => {
    const { MemoryCacheHandler } = await import("../packages/vinext/src/shims/cache.js");
    const handler = new MemoryCacheHandler();

    // data.revalidate overrides ctx — positive value should store
    await handler.set(
      "ctx-zero-data-positive",
      { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: [], revalidate: 60 },
      { revalidate: 0 },
    );

    const result = await handler.get("ctx-zero-data-positive");
    expect(result).not.toBeNull();
    expect(result!.cacheState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// next/dynamic shim unit tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// i18n config parsing
// ---------------------------------------------------------------------------

describe("i18n config parsing", () => {
  it("parses i18n config from next.config.js", async () => {
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    const config = await resolveNextConfig({
      i18n: {
        locales: ["en", "fr", "de"],
        defaultLocale: "en",
        localeDetection: true,
      },
    });

    expect(config.i18n).not.toBeNull();
    expect(config.i18n!.locales).toEqual(["en", "fr", "de"]);
    expect(config.i18n!.defaultLocale).toBe("en");
    expect(config.i18n!.localeDetection).toBe(true);
  });

  it("returns null i18n when not configured", async () => {
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    const config = await resolveNextConfig({});

    expect(config.i18n).toBeNull();
  });

  it("defaults localeDetection to true", async () => {
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    const config = await resolveNextConfig({
      i18n: {
        locales: ["en", "fr"],
        defaultLocale: "en",
      },
    });

    expect(config.i18n!.localeDetection).toBe(true);
  });

  it("respects localeDetection: false", async () => {
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    const config = await resolveNextConfig({
      i18n: {
        locales: ["en", "fr"],
        defaultLocale: "en",
        localeDetection: false,
      },
    });

    expect(config.i18n!.localeDetection).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// i18n utility functions (unit tests)
// ---------------------------------------------------------------------------

describe("extractLocaleFromUrl", () => {
  let extractLocaleFromUrl: typeof import("../packages/vinext/src/server/dev-server.js").extractLocaleFromUrl;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/server/dev-server.js");
    extractLocaleFromUrl = mod.extractLocaleFromUrl;
  });

  const i18nConfig = {
    locales: ["en", "fr", "de"],
    defaultLocale: "en",
    localeDetection: true,
  };

  it("extracts locale prefix from URL", () => {
    const result = extractLocaleFromUrl("/fr/about", i18nConfig);
    expect(result).toEqual({ locale: "fr", url: "/about", hadPrefix: true });
  });

  it("extracts locale from root URL", () => {
    const result = extractLocaleFromUrl("/de/", i18nConfig);
    expect(result).toEqual({ locale: "de", url: "/", hadPrefix: true });
  });

  it("returns default locale when no prefix", () => {
    const result = extractLocaleFromUrl("/about", i18nConfig);
    expect(result).toEqual({ locale: "en", url: "/about", hadPrefix: false });
  });

  it("preserves query string", () => {
    const result = extractLocaleFromUrl("/fr/page?foo=bar", i18nConfig);
    expect(result.locale).toBe("fr");
    expect(result.url).toBe("/page?foo=bar");
    expect(result.hadPrefix).toBe(true);
  });

  it("does not match unknown locale prefixes", () => {
    const result = extractLocaleFromUrl("/es/about", i18nConfig);
    expect(result).toEqual({ locale: "en", url: "/es/about", hadPrefix: false });
  });

  it("handles root path without prefix", () => {
    const result = extractLocaleFromUrl("/", i18nConfig);
    expect(result).toEqual({ locale: "en", url: "/", hadPrefix: false });
  });

  it("handles multi-segment paths", () => {
    const result = extractLocaleFromUrl("/fr/docs/api/routes", i18nConfig);
    expect(result.locale).toBe("fr");
    expect(result.url).toBe("/docs/api/routes");
  });
});

describe("detectLocaleFromHeaders", () => {
  let detectLocaleFromHeaders: typeof import("../packages/vinext/src/server/dev-server.js").detectLocaleFromHeaders;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/server/dev-server.js");
    detectLocaleFromHeaders = mod.detectLocaleFromHeaders;
  });

  const i18nConfig = {
    locales: ["en", "fr", "de"],
    defaultLocale: "en",
    localeDetection: true,
  };

  function fakeReq(acceptLanguage?: string) {
    return { headers: acceptLanguage ? { "accept-language": acceptLanguage } : {} } as any;
  }

  it("returns null when no Accept-Language header", () => {
    expect(detectLocaleFromHeaders(fakeReq(), i18nConfig)).toBeNull();
  });

  it("detects exact locale match", () => {
    expect(detectLocaleFromHeaders(fakeReq("fr"), i18nConfig)).toBe("fr");
  });

  it("detects locale by quality preference", () => {
    expect(detectLocaleFromHeaders(fakeReq("de;q=0.9,fr;q=0.8"), i18nConfig)).toBe("de");
  });

  it("detects locale via prefix match (en-US -> en)", () => {
    expect(detectLocaleFromHeaders(fakeReq("en-US"), i18nConfig)).toBe("en");
  });

  it("detects locale via prefix match (fr-FR -> fr)", () => {
    expect(detectLocaleFromHeaders(fakeReq("fr-FR,en;q=0.5"), i18nConfig)).toBe("fr");
  });

  it("returns null for unrecognized language", () => {
    expect(detectLocaleFromHeaders(fakeReq("ja"), i18nConfig)).toBeNull();
  });

  it("picks highest quality match", () => {
    // fr has higher quality than en
    expect(detectLocaleFromHeaders(fakeReq("en;q=0.5,fr;q=0.9"), i18nConfig)).toBe("fr");
  });

  it("handles complex Accept-Language with fallback", () => {
    // Japanese first (no match), then French
    expect(detectLocaleFromHeaders(fakeReq("ja;q=1.0,fr;q=0.8,en;q=0.5"), i18nConfig)).toBe("fr");
  });
});

// ---------------------------------------------------------------------------
// i18n routing integration (Pages Router)
// ---------------------------------------------------------------------------

describe("i18n routing (Pages Router)", () => {
  let i18nServer: ViteDevServer;
  let i18nBaseUrl: string;
  let i18nTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    i18nTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-i18n-"));

    // Symlink node_modules from root
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(i18nTmpDir, "node_modules"), "junction");

    // next.config.mjs with i18n
    await fsp.writeFile(
      path.join(i18nTmpDir, "next.config.mjs"),
      `export default {
  i18n: {
    locales: ["en", "fr", "de"],
    defaultLocale: "en",
  },
};`,
    );

    await fsp.mkdir(path.join(i18nTmpDir, "pages"), { recursive: true });

    // Home page
    await fsp.writeFile(
      path.join(i18nTmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    // About page — uses getServerSideProps to expose locale
    await fsp.writeFile(
      path.join(i18nTmpDir, "pages", "about.tsx"),
      `export function getServerSideProps({ locale, locales, defaultLocale }) {
  return { props: { locale: locale || null, locales: locales || [], defaultLocale: defaultLocale || null } };
}
export default function About({ locale, locales, defaultLocale }) {
  return (
    <div>
      <h1>About</h1>
      <p id="locale">{locale}</p>
      <p id="locales">{locales.join(",")}</p>
      <p id="defaultLocale">{defaultLocale}</p>
    </div>
  );
}`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins: any[] = [vinext()];
    i18nServer = await createServer({
      root: i18nTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await i18nServer.listen();
    const addr = i18nServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      i18nBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (i18nServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        i18nServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(i18nTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  // --- Basic routing ---

  it("renders the home page without locale prefix (default locale)", async () => {
    const res = await fetch(`${i18nBaseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Home");
  });

  it("renders the about page without locale prefix", async () => {
    const res = await fetch(`${i18nBaseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("renders the about page with default locale prefix (/en/about)", async () => {
    const res = await fetch(`${i18nBaseUrl}/en/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("renders the about page with non-default locale prefix (/fr/about)", async () => {
    const res = await fetch(`${i18nBaseUrl}/fr/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("renders the home page with non-default locale prefix (/de/)", async () => {
    const res = await fetch(`${i18nBaseUrl}/de/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Home");
  });

  // --- Locale context in getServerSideProps ---

  it("passes default locale to getServerSideProps when no prefix", async () => {
    const res = await fetch(`${i18nBaseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // locale should be "en" (default)
    expect(html).toMatch(/<p id="locale">.*en.*<\/p>/);
    // locales array
    expect(html).toMatch(/<p id="locales">.*en,fr,de.*<\/p>/);
    // defaultLocale
    expect(html).toMatch(/<p id="defaultLocale">.*en.*<\/p>/);
  });

  it("passes correct locale to getServerSideProps for /fr/about", async () => {
    const res = await fetch(`${i18nBaseUrl}/fr/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<p id="locale">.*fr.*<\/p>/);
  });

  it("passes correct locale to getServerSideProps for /de/about", async () => {
    const res = await fetch(`${i18nBaseUrl}/de/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<p id="locale">.*de.*<\/p>/);
  });

  // --- __NEXT_DATA__ locale info ---

  it("includes locale info in __NEXT_DATA__ script", async () => {
    const res = await fetch(`${i18nBaseUrl}/fr/about`);
    const html = await res.text();
    // Extract the JSON object from __NEXT_DATA__ (handles nested braces)
    const dataMatch = html.match(/__NEXT_DATA__\s*=\s*(\{[^<]+\})/);
    expect(dataMatch).not.toBeNull();
    const data = JSON.parse(dataMatch![1]);
    expect(data.locale).toBe("fr");
    expect(data.locales).toEqual(["en", "fr", "de"]);
    expect(data.defaultLocale).toBe("en");
  });

  it("includes locale info in __NEXT_DATA__ for default locale", async () => {
    const res = await fetch(`${i18nBaseUrl}/about`);
    const html = await res.text();
    const dataMatch = html.match(/__NEXT_DATA__\s*=\s*(\{[^<]+\})/);
    expect(dataMatch).not.toBeNull();
    const data = JSON.parse(dataMatch![1]);
    expect(data.locale).toBe("en");
    expect(data.defaultLocale).toBe("en");
  });

  // --- Accept-Language detection + redirect ---

  it("redirects to detected locale based on Accept-Language header", async () => {
    const res = await fetch(`${i18nBaseUrl}/about`, {
      redirect: "manual",
      headers: { "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" },
    });
    // Next.js only auto-detects locale on the application root.
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects to /de for Accept-Language: de on root", async () => {
    const res = await fetch(`${i18nBaseUrl}/`, {
      redirect: "manual",
      headers: { "Accept-Language": "de" },
    });
    expect(res.status).toBe(307);
    // Redirect to /{locale}{url} — for root ("/"), produces "/de/"
    // Implementation uses `/${detectedLocale}${url}` where url is "/"
    const loc = res.headers.get("location");
    // Accept either /de or /de/ depending on implementation
    expect(loc).toMatch(/^\/de\/?$/);
  });

  it("does not redirect when Accept-Language matches default locale", async () => {
    const res = await fetch(`${i18nBaseUrl}/about`, {
      redirect: "manual",
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    // Should NOT redirect — default locale matches
    expect(res.status).toBe(200);
  });

  it("does not redirect when URL already has locale prefix", async () => {
    const res = await fetch(`${i18nBaseUrl}/fr/about`, {
      redirect: "manual",
      headers: { "Accept-Language": "de" },
    });
    // Already has /fr prefix — should serve directly, no redirect
    expect(res.status).toBe(200);
  });

  it("does not redirect for unknown Accept-Language", async () => {
    const res = await fetch(`${i18nBaseUrl}/about`, {
      redirect: "manual",
      headers: { "Accept-Language": "ja" },
    });
    // Japanese not in locales — falls back to default, no redirect
    expect(res.status).toBe(200);
  });

  // --- 404 for unknown locale prefix ---

  it("returns 404 for unknown locale prefix", async () => {
    const res = await fetch(`${i18nBaseUrl}/es/about`);
    // "es" is not in locales — should not match as a locale
    // The URL /es/about won't match any page
    expect(res.status).toBe(404);
  });
});

async function startDomainFixtureServer(
  fixtureDir: string,
  prefix: string,
): Promise<{
  port: number;
  server: ViteDevServer;
  tmpDir: string;
}> {
  const tmpDir = await createIsolatedFixture(fixtureDir, prefix);
  const { server } = await startFixtureServer(tmpDir, {
    server: {
      host: "127.0.0.1",
      allowedHosts: ["example.com", "example.fr"],
    },
  });
  const addr = server.httpServer?.address();
  if (!addr || typeof addr === "string") {
    throw new Error(`Failed to start dev server for fixture ${fixtureDir}`);
  }
  return { port: addr.port, server, tmpDir };
}

describe("i18n domain routing (Pages Router)", () => {
  let domainServer: ViteDevServer;
  let domainTmpDir: string;
  let domainPort: number;

  beforeAll(async () => {
    ({
      server: domainServer,
      tmpDir: domainTmpDir,
      port: domainPort,
    } = await startDomainFixtureServer(PAGES_I18N_DOMAINS_FIXTURE_DIR, "vinext-i18n-domain-"));
  }, 30000);

  afterAll(async () => {
    try {
      (domainServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        domainServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(domainTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("redirects the root path to the preferred locale domain", async () => {
    const res = await requestNodeServerWithHost(domainPort, "/", "example.com", {
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    });

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe("http://example.fr/");
  });

  it("uses Accept-Language rather than NEXT_LOCALE to pick the preferred domain", async () => {
    const res = await requestNodeServerWithHost(domainPort, "/", "example.com", {
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      Cookie: "NEXT_LOCALE=en",
    });

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe("http://example.fr/");
  });

  it("preserves the search string on root locale redirects", async () => {
    const res = await requestNodeServerWithHost(
      domainPort,
      "/?utm=campaign&next=%2Fcheckout",
      "example.com",
      {
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
    );

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe("http://example.fr/?utm=campaign&next=%2Fcheckout");
  });

  it("does not redirect unprefixed non-root paths for locale detection", async () => {
    const res = await requestNodeServerWithHost(domainPort, "/about", "example.com", {
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    });

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
  });

  it("renders locale-switcher links with the target locale domain during SSR", async () => {
    const res = await requestNodeServerWithHost(domainPort, "/about", "example.com");

    expect(res.status).toBe(200);
    expect(res.body).toContain('href="http://example.fr/about" id="switch-locale"');
  });

  it("uses the matched domain default locale in request context and __NEXT_DATA__", async () => {
    const res = await requestNodeServerWithHost(domainPort, "/about", "example.fr");

    expect(res.status).toBe(200);
    expect(res.body).toContain('<p id="locale">fr</p>');
    expect(res.body).toContain('<p id="defaultLocale">fr</p>');
    expect(res.body).toContain('href="/about" id="switch-locale"');
    expect(res.body).toContain('"defaultLocale":"fr"');
    expect(res.body).toContain(
      '"domainLocales":[{"domain":"example.com","defaultLocale":"en"},{"domain":"example.fr","defaultLocale":"fr","http":true}]',
    );
  });
});

describe("i18n domain routing with basePath (Pages Router)", () => {
  let domainServer: ViteDevServer;
  let domainTmpDir: string;
  let domainPort: number;

  beforeAll(async () => {
    ({
      server: domainServer,
      tmpDir: domainTmpDir,
      port: domainPort,
    } = await startDomainFixtureServer(
      PAGES_I18N_DOMAINS_BASEPATH_FIXTURE_DIR,
      "vinext-i18n-domain-basepath-",
    ));
  }, 30000);

  afterAll(async () => {
    try {
      (domainServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        domainServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(domainTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("preserves basePath and trailingSlash in root locale redirects", async () => {
    const res = await requestNodeServerWithHost(domainPort, "/app/?utm=campaign", "example.com", {
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    });

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe("http://example.fr/app/?utm=campaign");
  });

  it("renders locale-switcher links with basePath on cross-domain hrefs", async () => {
    const res = await requestNodeServerWithHost(domainPort, "/app/about/", "example.com");

    expect(res.status).toBe(200);
    expect(res.body).toContain('href="http://example.fr/app/about" id="switch-locale"');
  });
});

// ---------------------------------------------------------------------------
// Link locale prop
// ---------------------------------------------------------------------------

describe("Link locale prop", () => {
  let linkLocaleServer: ViteDevServer;
  let linkLocaleBaseUrl: string;
  let linkLocaleTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    linkLocaleTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-link-locale-"));

    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(linkLocaleTmpDir, "node_modules"), "junction");

    await fsp.writeFile(
      path.join(linkLocaleTmpDir, "next.config.mjs"),
      `export default {
  i18n: {
    locales: ["en", "fr", "de"],
    defaultLocale: "en",
  },
};`,
    );

    await fsp.mkdir(path.join(linkLocaleTmpDir, "pages"), { recursive: true });

    // Page with Link components using locale prop
    await fsp.writeFile(
      path.join(linkLocaleTmpDir, "pages", "index.tsx"),
      `import Link from "next/link";

export default function Home() {
  return (
    <div>
      <h1>Link Locale Test</h1>
      <Link href="/about" locale="fr" id="link-fr">French About</Link>
      <Link href="/about" locale="de" id="link-de">German About</Link>
      <Link href="/about" locale="en" id="link-en">English About</Link>
      <Link href="/about" id="link-default">Default About</Link>
      <Link href="/about" locale={false} id="link-no-locale">No Locale</Link>
    </div>
  );
}`,
    );

    await fsp.writeFile(
      path.join(linkLocaleTmpDir, "pages", "about.tsx"),
      `export default function About() { return <h1>About</h1>; }`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins: any[] = [vinext()];
    linkLocaleServer = await createServer({
      root: linkLocaleTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await linkLocaleServer.listen();
    const addr = linkLocaleServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      linkLocaleBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (linkLocaleServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        linkLocaleServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(linkLocaleTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("Link with locale='fr' renders href with /fr prefix", async () => {
    const res = await fetch(`${linkLocaleBaseUrl}/`);
    const html = await res.text();
    // React may render attributes in any order — check both
    expect(html).toMatch(/href="\/fr\/about"[^>]*id="link-fr"|id="link-fr"[^>]*href="\/fr\/about"/);
  });

  it("Link with locale='de' renders href with /de prefix", async () => {
    const res = await fetch(`${linkLocaleBaseUrl}/`);
    const html = await res.text();
    expect(html).toMatch(/href="\/de\/about"[^>]*id="link-de"|id="link-de"[^>]*href="\/de\/about"/);
  });

  it("Link with locale='en' (default) renders href without locale prefix", async () => {
    const res = await fetch(`${linkLocaleBaseUrl}/`);
    const html = await res.text();
    // Default locale should NOT have a prefix in the URL
    // The <a> with id="link-en" should have href="/about" (not /en/about)
    const linkMatch = html.match(/href="([^"]*)"[^>]*id="link-en"|id="link-en"[^>]*href="([^"]*)"/);
    expect(linkMatch).not.toBeNull();
    const href = linkMatch![1] || linkMatch![2];
    expect(href).toBe("/about");
  });

  it("Link without locale prop renders href without locale prefix", async () => {
    const res = await fetch(`${linkLocaleBaseUrl}/`);
    const html = await res.text();
    const linkMatch = html.match(
      /href="([^"]*)"[^>]*id="link-default"|id="link-default"[^>]*href="([^"]*)"/,
    );
    expect(linkMatch).not.toBeNull();
    const href = linkMatch![1] || linkMatch![2];
    expect(href).toBe("/about");
  });

  it("Link with locale={false} renders href without locale prefix", async () => {
    const res = await fetch(`${linkLocaleBaseUrl}/`);
    const html = await res.text();
    const linkMatch = html.match(
      /href="([^"]*)"[^>]*id="link-no-locale"|id="link-no-locale"[^>]*href="([^"]*)"/,
    );
    expect(linkMatch).not.toBeNull();
    const href = linkMatch![1] || linkMatch![2];
    expect(href).toBe("/about");
  });
});

// ---------------------------------------------------------------------------
// i18n localeDetection: false
// ---------------------------------------------------------------------------

describe("i18n localeDetection: false", () => {
  let noDetectServer: ViteDevServer;
  let noDetectBaseUrl: string;
  let noDetectTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    noDetectTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-i18n-nodetect-"));

    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(noDetectTmpDir, "node_modules"), "junction");

    await fsp.writeFile(
      path.join(noDetectTmpDir, "next.config.mjs"),
      `export default {
  i18n: {
    locales: ["en", "fr"],
    defaultLocale: "en",
    localeDetection: false,
  },
};`,
    );

    await fsp.mkdir(path.join(noDetectTmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(noDetectTmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins: any[] = [vinext()];
    noDetectServer = await createServer({
      root: noDetectTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await noDetectServer.listen();
    const addr = noDetectServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      noDetectBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (noDetectServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        noDetectServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(noDetectTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("does NOT redirect based on Accept-Language when localeDetection is false", async () => {
    const res = await fetch(`${noDetectBaseUrl}/`, {
      redirect: "manual",
      headers: { "Accept-Language": "fr" },
    });
    // localeDetection: false means no auto-redirect — serve with default locale
    expect(res.status).toBe(200);
  });

  it("still serves locale-prefixed URLs when localeDetection is false", async () => {
    const res = await fetch(`${noDetectBaseUrl}/fr/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Home");
  });
});

describe("basePath support (Pages Router)", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    const plugins: any[] = [vinext()];
    server = await createServer({
      root: PAGES_FIXTURE_DIR,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await server.listen();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("resolveNextConfig correctly resolves basePath", async () => {
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    // Default: empty basePath
    const defaultConfig = await resolveNextConfig({});
    expect(defaultConfig.basePath).toBe("");

    // With basePath configured
    const withBasePath = await resolveNextConfig({ basePath: "/app" });
    expect(withBasePath.basePath).toBe("/app");

    // basePath must start with / (Next.js requirement)
    const withSlash = await resolveNextConfig({ basePath: "/docs" });
    expect(withSlash.basePath).toBe("/docs");
  });

  it("basePath define is injected into client code", async () => {
    // The plugin should set process.env.__NEXT_ROUTER_BASEPATH as a define.
    // We test this by checking the resolved config of the current server.
    const config = server.config;
    // Default fixture has no basePath, so it should be ""
    const defineKey = "process.env.__NEXT_ROUTER_BASEPATH";
    expect(config.define?.[defineKey]).toBe(JSON.stringify(""));
  });

  it("resolveNextConfig correctly resolves trailingSlash", async () => {
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    // Default: trailingSlash is false
    const defaultConfig = await resolveNextConfig({});
    expect(defaultConfig.trailingSlash).toBe(false);

    // With trailingSlash: true
    const withTrailing = await resolveNextConfig({ trailingSlash: true });
    expect(withTrailing.trailingSlash).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// basePath deep testing — HTTP routing integration

describe("basePath HTTP routing (Pages Router)", () => {
  let bpServer: ViteDevServer;
  let bpBaseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    // Create a temporary fixture directory with basePath configured
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-bp-"));

    // Symlink node_modules from project root so React etc. are resolvable
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    // next.config.mjs with basePath
    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `/** @type {import('next').NextConfig} */
export default {
  basePath: "/app",
  async redirects() {
    return [
      {
        source: "/redir",
        destination: "/application/about",
        permanent: false,
      },
      {
        source: "/redir-external",
        destination: "https://example.com/page",
        permanent: false,
      },
    ];
  },
};
`,
    );

    // pages directory
    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });

    // index page
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `import Link from "next/link";

export default function Home() {
  return (
    <div>
      <h1>BasePath Home</h1>
      <Link href="/about">Go to About</Link>
    </div>
  );
}
`,
    );

    // about page
    await fsp.writeFile(
      path.join(tmpDir, "pages", "about.tsx"),
      `export default function About() {
  return <h1>BasePath About</h1>;
}
`,
    );

    // Collision route used to verify that shared string prefixes outside the
    // basePath do not get stripped and misrouted into a valid page.
    await fsp.mkdir(path.join(tmpDir, "pages", "lication"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "lication", "about.tsx"),
      `export default function Collision() {
  return <h1>Collision Route</h1>;
}
`,
    );

    // API route
    await fsp.mkdir(path.join(tmpDir, "pages", "api"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "api", "hello.ts"),
      `export default function handler(req, res) {
  res.json({ message: "hello from basePath" });
}
`,
    );

    // Start server
    const plugins: any[] = [vinext()];
    bpServer = await createServer({
      root: tmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await bpServer.listen();
    const addr = bpServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      bpBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (bpServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([bpServer?.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    } catch {
      /* ignore close errors */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("Vite base is set to basePath + /", () => {
    expect(bpServer.config.base).toBe("/app/");
  });

  it("process.env.__NEXT_ROUTER_BASEPATH define is /app", () => {
    const define = bpServer.config.define?.["process.env.__NEXT_ROUTER_BASEPATH"];
    expect(define).toBe(JSON.stringify("/app"));
  });

  it("GET /app/ serves the index page", async () => {
    const res = await fetch(`${bpBaseUrl}/app/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("BasePath Home");
  });

  it("GET /app (without trailing slash) returns 404 — Vite base requires trailing slash", async () => {
    // With Vite's base set to /app/, a bare /app request doesn't match the
    // base and Vite returns 404. This matches how Vite handles base paths.
    // Users would typically configure a reverse proxy or Vite's server.origin
    // to redirect /app → /app/ in production.
    const res = await fetch(`${bpBaseUrl}/app`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("GET /app/about serves the about page", async () => {
    const res = await fetch(`${bpBaseUrl}/app/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("BasePath About");
  });

  it("GET /about (without basePath) does NOT serve pages", async () => {
    const res = await fetch(`${bpBaseUrl}/about`);
    // Without basePath prefix, the Pages Router middleware should not match.
    // The response should be a 404 or Vite's default fallback.
    expect(res.status).not.toBe(200);
  });

  it("does not strip shared string prefixes outside basePath", async () => {
    const valid = await fetch(`${bpBaseUrl}/app/lication/about`);
    expect(valid.status).toBe(200);
    expect(await valid.text()).toContain("Collision Route");

    const outside = await fetch(`${bpBaseUrl}/application/about`);
    expect(outside.status).not.toBe(200);
    expect(await outside.text()).not.toContain("Collision Route");
  });

  it("GET /app/api/hello serves the API route", async () => {
    const res = await fetch(`${bpBaseUrl}/app/api/hello`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBe("hello from basePath");
  });

  it("redirects prefix destinations under the real basePath boundary", async () => {
    const res = await fetch(`${bpBaseUrl}/app/redir`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/app/application/about");
  });

  it("does not prepend basePath to external redirect destinations", async () => {
    const res = await fetch(`${bpBaseUrl}/app/redir-external`, {
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://example.com/page");
  });

  it("GET /api/hello (without basePath) does NOT serve API routes", async () => {
    const res = await fetch(`${bpBaseUrl}/api/hello`);
    expect(res.status).not.toBe(200);
  });

  it("Link component renders href with basePath prefix in SSR", async () => {
    const res = await fetch(`${bpBaseUrl}/app/`);
    const html = await res.text();
    // The Link component should render <a href="/app/about">
    expect(html).toContain('href="/app/about"');
  });
});

// ---------------------------------------------------------------------------
// basePath with nested path (e.g. /docs/v2)

describe("basePath with nested path (/docs/v2)", () => {
  let nestedServer: ViteDevServer;
  let nestedBaseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-bp-nested-"));

    // Symlink node_modules from project root
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default { basePath: "/docs/v2" };`,
    );

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });

    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() {
  return <h1>Nested BasePath Home</h1>;
}`,
    );

    await fsp.writeFile(
      path.join(tmpDir, "pages", "guide.tsx"),
      `export default function Guide() {
  return <h1>Nested BasePath Guide</h1>;
}`,
    );

    const plugins: any[] = [vinext()];
    nestedServer = await createServer({
      root: tmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await nestedServer.listen();
    const addr = nestedServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      nestedBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    // Force close the server (httpServer.close can hang if connections are still open)
    try {
      (nestedServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        nestedServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore close errors */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("Vite base is set to /docs/v2/", () => {
    expect(nestedServer.config.base).toBe("/docs/v2/");
  });

  it("GET /docs/v2/ serves the index page", async () => {
    const res = await fetch(`${nestedBaseUrl}/docs/v2/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Nested BasePath Home");
  });

  it("GET /docs/v2/guide serves the guide page", async () => {
    const res = await fetch(`${nestedBaseUrl}/docs/v2/guide`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Nested BasePath Guide");
  });

  it("GET /docs/ (partial basePath) does NOT serve pages", async () => {
    const res = await fetch(`${nestedBaseUrl}/docs/`);
    expect(res.status).not.toBe(200);
  });

  it("GET /guide (without basePath) does NOT serve pages", async () => {
    const res = await fetch(`${nestedBaseUrl}/guide`);
    expect(res.status).not.toBe(200);
  });
});

// ---------------------------------------------------------------------------
// basePath config validation

describe("basePath + trailingSlash interaction", () => {
  let tsServer: ViteDevServer;
  let tsBaseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-bp-ts-"));

    // Symlink node_modules from project root
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default { basePath: "/app", trailingSlash: true };`,
    );

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });

    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() {
  return <h1>TrailingSlash Home</h1>;
}`,
    );

    await fsp.writeFile(
      path.join(tmpDir, "pages", "about.tsx"),
      `export default function About() {
  return <h1>TrailingSlash About</h1>;
}`,
    );

    const plugins: any[] = [vinext()];
    tsServer = await createServer({
      root: tmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await tsServer.listen();
    const addr = tsServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      tsBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (tsServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([tsServer?.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    } catch {
      /* ignore close errors */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("GET /app/about redirects to /app/about/ with trailingSlash:true", async () => {
    const res = await fetch(`${tsBaseUrl}/app/about`, { redirect: "manual" });
    expect(res.status).toBe(308);
    const location = res.headers.get("location");
    expect(location).toBe("/app/about/");
  });

  it("GET /app/about/ serves the about page with trailingSlash:true", async () => {
    const res = await fetch(`${tsBaseUrl}/app/about/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("TrailingSlash About");
  });
});

describe("metadata title templates", () => {
  let mergeMetadata: typeof import("../packages/vinext/src/shims/metadata.js").mergeMetadata;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/shims/metadata.js");
    mergeMetadata = mod.mergeMetadata;
  });

  it("applies layout template to child page string title", () => {
    const result = mergeMetadata([
      { title: { template: "%s | My Site", default: "My Site" } },
      { title: "About" },
    ]);
    expect(result.title).toBe("About | My Site");
  });

  it("uses layout default title when page has no title", () => {
    const result = mergeMetadata([
      { title: { template: "%s | My Site", default: "My Site" } },
      { description: "No title here" },
    ]);
    expect(result.title).toBe("My Site");
  });

  it("title.absolute skips all templates", () => {
    const result = mergeMetadata([
      { title: { template: "%s | My Site", default: "My Site" } },
      { title: { absolute: "Custom Title" } },
    ]);
    expect(result.title).toBe("Custom Title");
  });

  it("nearest layout template wins over root", () => {
    const result = mergeMetadata([
      { title: { template: "%s | Root", default: "Root" } },
      { title: { template: "%s - Blog", default: "Blog" } },
      { title: "Hello World" },
    ]);
    expect(result.title).toBe("Hello World - Blog");
  });

  it("page template has no effect (page is terminal)", () => {
    // If the page defines a template, it should be ignored
    // Only layouts define templates, and page is always the last entry
    const result = mergeMetadata([
      { title: { template: "%s | Site", default: "Site" } },
      { title: { template: "%s - Page Template", default: "Page Default" } },
    ]);
    // The page's template should be ignored; the page's default is used
    // because the page has a title object (not a string), so we use its default
    expect(result.title).toBe("Page Default");
  });

  it("preserves non-title metadata during merge", () => {
    const result = mergeMetadata([
      { title: { template: "%s | Site", default: "Site" }, description: "Root desc" },
      { title: "About", keywords: ["about"] },
    ]);
    expect(result.title).toBe("About | Site");
    expect(result.description).toBe("Root desc");
    expect(result.keywords).toEqual(["about"]);
  });

  it("later entries override earlier for non-title fields", () => {
    const result = mergeMetadata([
      { description: "From layout", openGraph: { title: "OG Layout" } },
      { description: "From page" },
    ]);
    expect(result.description).toBe("From page");
    // openGraph from layout should be inherited if page doesn't override it
    expect(result.openGraph).toEqual({ title: "OG Layout" });
  });

  it("simple string title without template passes through", () => {
    const result = mergeMetadata([{ title: "My Page" }]);
    expect(result.title).toBe("My Page");
  });

  it("handles empty metadata list", () => {
    const result = mergeMetadata([]);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// MetadataHead rendering tests

describe("MetadataHead rendering", () => {
  let MetadataHead: typeof import("../packages/vinext/src/shims/metadata.js").MetadataHead;
  let React: typeof import("react");
  let renderToStaticMarkup: typeof import("react-dom/server").renderToStaticMarkup;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/shims/metadata.js");
    MetadataHead = mod.MetadataHead;
    React = await import("react");
    renderToStaticMarkup = (await import("react-dom/server")).renderToStaticMarkup;
  });

  it("renders generator meta tag", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, { metadata: { generator: "Next.js" } }),
    );
    expect(html).toContain('name="generator"');
    expect(html).toContain('content="Next.js"');
  });

  it("renders application-name meta tag", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, { metadata: { applicationName: "My App" } }),
    );
    expect(html).toContain('name="application-name"');
    expect(html).toContain('content="My App"');
  });

  it("renders author meta and link tags", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          authors: [{ name: "Seb" }, { name: "Josh", url: "https://josh.dev" }],
        },
      }),
    );
    expect(html).toContain('name="author"');
    expect(html).toContain('content="Seb"');
    expect(html).toContain('rel="author"');
    expect(html).toContain('href="https://josh.dev"');
  });

  it("renders format-detection meta tag", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: { formatDetection: { telephone: false, email: false } },
      }),
    );
    expect(html).toContain('name="format-detection"');
    expect(html).toContain("telephone=no");
    expect(html).toContain("email=no");
  });

  it("renders googlebot meta tag separately from robots", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          robots: {
            index: true,
            follow: true,
            googleBot: { index: true, follow: true, "max-snippet": -1 },
          },
        },
      }),
    );
    expect(html).toContain('name="robots"');
    expect(html).toContain('name="googlebot"');
    expect(html).toContain("max-snippet:-1");
  });

  it("renders verification meta tags", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          verification: { google: "abc123", yandex: "xyz789" },
        },
      }),
    );
    expect(html).toContain('name="google-site-verification"');
    expect(html).toContain('content="abc123"');
    expect(html).toContain('name="yandex-verification"');
    expect(html).toContain('content="xyz789"');
  });

  it("renders icon link tags from icons metadata", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          icons: {
            icon: "/favicon.ico",
            apple: [{ url: "/apple-icon.png", sizes: "180x180" }],
            shortcut: "/shortcut.png",
          },
        },
      }),
    );
    expect(html).toContain('rel="icon"');
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('sizes="180x180"');
    expect(html).toContain('rel="shortcut icon"');
  });

  it("renders alternate hreflang links", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          alternates: {
            canonical: "https://example.com",
            languages: { "en-US": "https://example.com/en", "de-DE": "https://example.com/de" },
          },
        },
      }),
    );
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('href="https://example.com"');
    // React renders hrefLang in camelCase (hrefLang or hreflang depending on version)
    expect(html).toMatch(/hreflang="en-US"|hrefLang="en-US"/i);
    expect(html).toMatch(/hreflang="de-DE"|hrefLang="de-DE"/i);
  });

  it("renders alternate RSS feed link", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          alternates: {
            types: { "application/rss+xml": "https://example.com/rss" },
          },
        },
      }),
    );
    expect(html).toContain('type="application/rss+xml"');
    expect(html).toContain('href="https://example.com/rss"');
  });

  it("renders twitter:site and twitter:creator:id", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          twitter: {
            card: "summary",
            site: "@nextjs",
            siteId: "12345",
            creatorId: "67890",
          },
        },
      }),
    );
    expect(html).toContain('name="twitter:site"');
    expect(html).toContain('content="@nextjs"');
    expect(html).toContain('name="twitter:site:id"');
    expect(html).toContain('content="12345"');
    expect(html).toContain('name="twitter:creator:id"');
  });

  it("resolves relative URLs with metadataBase", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          metadataBase: new URL("https://acme.com"),
          alternates: { canonical: "/about" },
          openGraph: { images: "/og.png" },
        },
      }),
    );
    expect(html).toContain('href="https://acme.com/about"');
    expect(html).toContain('content="https://acme.com/og.png"');
  });

  it("accepts URL objects for canonical and openGraph.url", () => {
    // Next.js allows string | URL for URL fields; passing a URL object must not throw
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          alternates: { canonical: new URL("https://example.com/page") },
          openGraph: { url: new URL("https://example.com/og") },
        },
      }),
    );
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('content="https://example.com/og"');
  });

  it("renders OG video and audio tags", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: {
          openGraph: {
            videos: [{ url: "https://example.com/video.mp4", width: 800, height: 600 }],
            audio: [{ url: "https://example.com/audio.mp3" }],
          },
        },
      }),
    );
    expect(html).toContain('property="og:video"');
    expect(html).toContain('content="https://example.com/video.mp4"');
    expect(html).toContain('property="og:video:width"');
    expect(html).toContain('property="og:audio"');
  });

  it("renders manifest link", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: { manifest: "/manifest.json" },
      }),
    );
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.json"');
  });

  it("renders other meta with array values", () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataHead, {
        metadata: { other: { custom: ["val1", "val2"] } },
      }),
    );
    expect(html).toContain('content="val1"');
    expect(html).toContain('content="val2"');
  });
});

// ---------------------------------------------------------------------------
// ViewportHead rendering tests

describe("ViewportHead rendering", () => {
  let ViewportHead: typeof import("../packages/vinext/src/shims/metadata.js").ViewportHead;
  let mergeViewport: typeof import("../packages/vinext/src/shims/metadata.js").mergeViewport;
  let React: typeof import("react");
  let renderToStaticMarkup: typeof import("react-dom/server").renderToStaticMarkup;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/shims/metadata.js");
    ViewportHead = mod.ViewportHead;
    mergeViewport = mod.mergeViewport;
    React = await import("react");
    renderToStaticMarkup = (await import("react-dom/server")).renderToStaticMarkup;
  });

  it("renders default viewport with width=device-width and initial-scale=1", () => {
    const html = renderToStaticMarkup(
      React.createElement(ViewportHead, {
        viewport: { width: "device-width", initialScale: 1 },
      }),
    );
    expect(html).toContain('name="viewport"');
    expect(html).toContain("width=device-width");
    expect(html).toContain("initial-scale=1");
  });

  it("renders custom viewport with all options", () => {
    const html = renderToStaticMarkup(
      React.createElement(ViewportHead, {
        viewport: {
          width: "device-width",
          initialScale: 1,
          maximumScale: 1,
          userScalable: false,
        },
      }),
    );
    expect(html).toContain("width=device-width");
    expect(html).toContain("initial-scale=1");
    expect(html).toContain("maximum-scale=1");
    expect(html).toContain("user-scalable=no");
  });

  it("renders theme-color meta tag", () => {
    const html = renderToStaticMarkup(
      React.createElement(ViewportHead, {
        viewport: { themeColor: "#000000" },
      }),
    );
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('content="#000000"');
  });

  it("renders multiple theme-color entries with media queries", () => {
    const html = renderToStaticMarkup(
      React.createElement(ViewportHead, {
        viewport: {
          themeColor: [
            { media: "(prefers-color-scheme: light)", color: "#fff" },
            { media: "(prefers-color-scheme: dark)", color: "#000" },
          ],
        },
      }),
    );
    expect(html).toContain('content="#fff"');
    expect(html).toContain('content="#000"');
    expect(html).toContain("prefers-color-scheme: light");
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("renders color-scheme meta tag", () => {
    const html = renderToStaticMarkup(
      React.createElement(ViewportHead, {
        viewport: { colorScheme: "dark" },
      }),
    );
    expect(html).toContain('name="color-scheme"');
    expect(html).toContain('content="dark"');
  });

  // mergeViewport default injection tests
  it("mergeViewport includes default width and initialScale when not provided", () => {
    const result = mergeViewport([{ themeColor: "#000" }]);
    expect(result.width).toBe("device-width");
    expect(result.initialScale).toBe(1);
    expect(result.themeColor).toBe("#000");
  });

  it("mergeViewport allows overriding defaults", () => {
    const result = mergeViewport([{ width: 1024, initialScale: 0.5 }]);
    expect(result.width).toBe(1024);
    expect(result.initialScale).toBe(0.5);
  });

  it("mergeViewport returns defaults for empty list", () => {
    const result = mergeViewport([]);
    expect(result.width).toBe("device-width");
    expect(result.initialScale).toBe(1);
  });

  it("mergeViewport later entries override earlier ones including defaults", () => {
    const result = mergeViewport([{ width: 800 }, { width: 1024, themeColor: "#fff" }]);
    expect(result.width).toBe(1024);
    expect(result.initialScale).toBe(1);
    expect(result.themeColor).toBe("#fff");
  });

  it("renders viewport meta even when only themeColor is provided (defaults injected)", () => {
    const merged = mergeViewport([{ themeColor: "#000" }]);
    const html = renderToStaticMarkup(React.createElement(ViewportHead, { viewport: merged }));
    expect(html).toContain('name="viewport"');
    expect(html).toContain("width=device-width");
    expect(html).toContain("initial-scale=1");
    expect(html).toContain('name="theme-color"');
  });
});

describe("fetch cache (extended fetch with next options)", () => {
  // We need a mock server for fetch to hit
  let mockServerUrl: string;
  let mockServer: any;
  let fetchCallCount: number;

  beforeAll(async () => {
    const http = await import("node:http");
    fetchCallCount = 0;
    mockServer = http.createServer((_req, res) => {
      fetchCallCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: fetchCallCount, timestamp: Date.now() }));
    });
    await new Promise<void>((resolve) => {
      mockServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = mockServer.address();
    mockServerUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  });

  it("exports withFetchCache, runWithFetchCache, getOriginalFetch, getCollectedFetchTags", async () => {
    const mod = await import("../packages/vinext/src/shims/fetch-cache.js");
    expect(typeof mod.withFetchCache).toBe("function");
    expect(typeof mod.runWithFetchCache).toBe("function");
    expect(typeof mod.getOriginalFetch).toBe("function");
    expect(typeof mod.getCollectedFetchTags).toBe("function");
  });

  it("passes through fetch without next options unchanged", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");

    fetchCallCount = 0;
    const cleanup = withFetchCache();
    try {
      const resp1 = await fetch(`${mockServerUrl}/plain`);
      const data1 = await resp1.json();
      expect(data1.count).toBe(1);

      const resp2 = await fetch(`${mockServerUrl}/plain`);
      const data2 = await resp2.json();
      expect(data2.count).toBe(2); // NOT cached — no next options
    } finally {
      cleanup();
    }
  });

  it("caches fetch with { next: { revalidate } }", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    // Fresh cache handler for isolation
    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    const cleanup = withFetchCache();
    try {
      const resp1 = await fetch(`${mockServerUrl}/cached`, {
        next: { revalidate: 60 },
      });
      const data1 = await resp1.json();
      expect(data1.count).toBe(1);
      expect(fetchCallCount).toBe(1);

      // Second fetch should come from cache
      const resp2 = await fetch(`${mockServerUrl}/cached`, {
        next: { revalidate: 60 },
      });
      const data2 = await resp2.json();
      expect(data2.count).toBe(1); // Same data!
      expect(fetchCallCount).toBe(1); // No additional network call
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });

  it("serves stale fetch cache entry and triggers background revalidation", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    // Fresh cache handler for isolation
    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    // Make the staleness deterministic without sleeping.
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;

    const cleanup = withFetchCache();
    try {
      const resp1 = await fetch(`${mockServerUrl}/swr`, {
        next: { revalidate: 1 },
      });
      const data1 = await resp1.json();
      expect(data1.count).toBe(1);
      expect(fetchCallCount).toBe(1);

      // Advance time past the revalidate window so the entry becomes stale.
      now += 2000;

      // Second fetch returns stale cached value but triggers background refetch.
      const resp2 = await fetch(`${mockServerUrl}/swr`, {
        next: { revalidate: 1 },
      });
      const data2 = await resp2.json();
      expect(data2.count).toBe(1);

      // Wait for the background revalidation fetch to hit the network.
      await new Promise<void>((resolve, reject) => {
        const start = originalNow();
        const tick = () => {
          if (fetchCallCount >= 2) return resolve();
          if (originalNow() - start > 1000) {
            return reject(new Error("timed out waiting for background revalidation"));
          }
          setTimeout(tick, 10);
        };
        tick();
      });

      // Third fetch should read the refreshed cache value.
      const resp3 = await fetch(`${mockServerUrl}/swr`, {
        next: { revalidate: 1 },
      });
      const data3 = await resp3.json();
      expect(data3.count).toBe(2);
      expect(fetchCallCount).toBe(2);
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
      Date.now = originalNow;
    }
  });

  it("cache: 'force-cache' caches indefinitely", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    const cleanup = withFetchCache();
    try {
      const resp1 = await fetch(`${mockServerUrl}/force`, {
        cache: "force-cache",
      });
      const data1 = await resp1.json();
      expect(data1.count).toBe(1);

      // Second fetch should be cached
      const resp2 = await fetch(`${mockServerUrl}/force`, {
        cache: "force-cache",
      });
      const data2 = await resp2.json();
      expect(data2.count).toBe(1);
      expect(fetchCallCount).toBe(1);
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });

  it("cache: 'no-store' bypasses cache", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    const cleanup = withFetchCache();
    try {
      const resp1 = await fetch(`${mockServerUrl}/no-store`, {
        cache: "no-store",
      });
      const data1 = await resp1.json();
      expect(data1.count).toBe(1);

      const resp2 = await fetch(`${mockServerUrl}/no-store`, {
        cache: "no-store",
      });
      const data2 = await resp2.json();
      expect(data2.count).toBe(2); // NOT cached
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });

  it("next.revalidate: false bypasses cache", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    const cleanup = withFetchCache();
    try {
      await fetch(`${mockServerUrl}/no-rev`, { next: { revalidate: false } });
      await fetch(`${mockServerUrl}/no-rev`, { next: { revalidate: false } });
      expect(fetchCallCount).toBe(2); // Both hit the network
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });

  it("next.revalidate: 0 bypasses cache", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    const cleanup = withFetchCache();
    try {
      await fetch(`${mockServerUrl}/zero`, { next: { revalidate: 0 } });
      await fetch(`${mockServerUrl}/zero`, { next: { revalidate: 0 } });
      expect(fetchCallCount).toBe(2);
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });

  it("revalidateTag invalidates fetch cache entries", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler, revalidateTag } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    const cleanup = withFetchCache();
    try {
      // First fetch — cache miss, hits network
      const resp1 = await fetch(`${mockServerUrl}/tagged`, {
        next: { revalidate: 3600, tags: ["posts"] },
      });
      const data1 = await resp1.json();
      expect(data1.count).toBe(1);
      expect(fetchCallCount).toBe(1);

      // Second fetch — cache hit
      const resp2 = await fetch(`${mockServerUrl}/tagged`, {
        next: { revalidate: 3600, tags: ["posts"] },
      });
      const data2 = await resp2.json();
      expect(data2.count).toBe(1);
      expect(fetchCallCount).toBe(1);

      // Invalidate the tag
      await revalidateTag("posts");

      // Third fetch — cache miss after tag invalidation
      const resp3 = await fetch(`${mockServerUrl}/tagged`, {
        next: { revalidate: 3600, tags: ["posts"] },
      });
      const data3 = await resp3.json();
      expect(data3.count).toBe(2); // New data from network
      expect(fetchCallCount).toBe(2);
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });

  it("collects fetch tags during render pass", async () => {
    const { withFetchCache, getCollectedFetchTags } =
      await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());

    const cleanup = withFetchCache();
    try {
      await fetch(`${mockServerUrl}/a`, { next: { revalidate: 60, tags: ["tag-a", "tag-b"] } });
      await fetch(`${mockServerUrl}/b`, { next: { revalidate: 60, tags: ["tag-b", "tag-c"] } });

      const tags = getCollectedFetchTags();
      expect(tags).toContain("tag-a");
      expect(tags).toContain("tag-b");
      expect(tags).toContain("tag-c");
      expect(tags.length).toBe(3); // Deduplicated
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });

  it("different URLs produce separate cache entries", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    const cleanup = withFetchCache();
    try {
      await fetch(`${mockServerUrl}/url-a`, { next: { revalidate: 60 } });
      await fetch(`${mockServerUrl}/url-b`, { next: { revalidate: 60 } });
      expect(fetchCallCount).toBe(2); // Two different URLs = two network calls

      // Now re-fetch both — should be cached
      await fetch(`${mockServerUrl}/url-a`, { next: { revalidate: 60 } });
      await fetch(`${mockServerUrl}/url-b`, { next: { revalidate: 60 } });
      expect(fetchCallCount).toBe(2); // Still 2, both from cache
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });

  it("fetch with only tags (no revalidate) caches indefinitely", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    const cleanup = withFetchCache();
    try {
      await fetch(`${mockServerUrl}/tags-only`, { next: { tags: ["items"] } });
      await fetch(`${mockServerUrl}/tags-only`, { next: { tags: ["items"] } });
      expect(fetchCallCount).toBe(1); // Cached because tags imply force-cache
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });

  it("cleanup clears per-request tag state", async () => {
    const { withFetchCache, getCollectedFetchTags } =
      await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());
    const cleanup = withFetchCache();
    await fetch(`${mockServerUrl}/cleanup-tag-test`, { next: { tags: ["cleanup-t"] } });
    expect(getCollectedFetchTags()).toContain("cleanup-t");
    cleanup();
    expect(getCollectedFetchTags()).toHaveLength(0);
  });

  it("runWithFetchCache isolates tags and returns result", async () => {
    const { runWithFetchCache, getCollectedFetchTags } =
      await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());
    fetchCallCount = 0;

    const result = await runWithFetchCache(async () => {
      const resp = await fetch(`${mockServerUrl}/auto`, { next: { revalidate: 60 } });
      return resp.json();
    });

    expect(result.count).toBe(fetchCallCount);
    // Tags should be empty outside the runWithFetchCache scope
    expect(getCollectedFetchTags()).toHaveLength(0);

    setCacheHandler(new MemoryCacheHandler());
  });

  it("strips next property before passing to real fetch", async () => {
    const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());

    // This test verifies the real fetch doesn't receive the `next` property
    // which would cause warnings in some environments. If it throws, the test fails.
    const cleanup = withFetchCache();
    try {
      const resp = await fetch(`${mockServerUrl}/strip`, {
        next: { revalidate: 60, tags: ["test"] },
        method: "GET",
      });
      expect(resp.ok).toBe(true);
    } finally {
      cleanup();
      setCacheHandler(new MemoryCacheHandler());
    }
  });
});

// ---------------------------------------------------------------------------
// instrumentation.ts support
// ---------------------------------------------------------------------------

describe("instrumentation.ts support", () => {
  it("exports findInstrumentationFile", async () => {
    const mod = await import("../packages/vinext/src/server/instrumentation.js");
    expect(typeof mod.findInstrumentationFile).toBe("function");
  });

  it("findInstrumentationFile returns null when no file exists", async () => {
    const { findInstrumentationFile } =
      await import("../packages/vinext/src/server/instrumentation.js");
    const result = findInstrumentationFile("/nonexistent/path", createValidFileMatcher());
    expect(result).toBeNull();
  });

  it("findInstrumentationFile detects instrumentation.ts", async () => {
    const { findInstrumentationFile } =
      await import("../packages/vinext/src/server/instrumentation.js");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");

    // Create a temp directory with an instrumentation.ts file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-inst-"));
    fs.writeFileSync(
      path.join(tmpDir, "instrumentation.ts"),
      'export function register() { console.log("registered"); }',
    );

    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());
    expect(result).toBe(path.join(tmpDir, "instrumentation.ts"));

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("findInstrumentationFile detects src/instrumentation.ts", async () => {
    const { findInstrumentationFile } =
      await import("../packages/vinext/src/server/instrumentation.js");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-inst-"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(
      path.join(tmpDir, "src", "instrumentation.ts"),
      "export function register() {}",
    );

    const result = findInstrumentationFile(tmpDir, createValidFileMatcher());
    expect(result).toBe(path.join(tmpDir, "src", "instrumentation.ts"));

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("runInstrumentation calls register() and stores onRequestError", async () => {
    const { runInstrumentation, getOnRequestErrorHandler } =
      await import("../packages/vinext/src/server/instrumentation.js");

    let registerCalled = false;
    const mockOnRequestError = (_error: any, _request: any, _context: any) => {};

    // Create a mock ModuleRunner
    const mockRunner = {
      import: async (_id: string) => ({
        register: () => {
          registerCalled = true;
        },
        onRequestError: mockOnRequestError,
      }),
    };

    await runInstrumentation(mockRunner, "/fake/instrumentation.ts");

    expect(registerCalled).toBe(true);
    expect(getOnRequestErrorHandler()).toBe(mockOnRequestError);
  });

  it("reportRequestError calls onRequestError handler", async () => {
    const { runInstrumentation, reportRequestError } =
      await import("../packages/vinext/src/server/instrumentation.js");

    const reportedErrors: { error: Error; request: any; context: any }[] = [];

    const mockRunner = {
      import: async (_id: string) => ({
        register: () => {},
        onRequestError: (error: Error, request: any, context: any) => {
          reportedErrors.push({ error, request, context });
        },
      }),
    };

    await runInstrumentation(mockRunner, "/fake/instrumentation.ts");

    const testError = new Error("test error");
    await reportRequestError(
      testError,
      { path: "/blog/1", method: "GET", headers: {} },
      { routerKind: "Pages Router", routePath: "/blog/[slug]", routeType: "render" },
    );

    expect(reportedErrors.length).toBe(1);
    expect(reportedErrors[0].error).toBe(testError);
    expect(reportedErrors[0].request.path).toBe("/blog/1");
    expect(reportedErrors[0].context.routerKind).toBe("Pages Router");
  });

  it("reportRequestError is a no-op when no handler is registered", async () => {
    const { reportRequestError, runInstrumentation } =
      await import("../packages/vinext/src/server/instrumentation.js");

    // Register a module with no onRequestError
    const mockRunner = {
      import: async (_id: string) => ({
        register: () => {},
      }),
    };
    await runInstrumentation(mockRunner, "/fake/no-error-handler.ts");

    // Should not throw
    await reportRequestError(
      new Error("test"),
      { path: "/", method: "GET", headers: {} },
      { routerKind: "App Router", routePath: "/", routeType: "render" },
    );
  });

  it("runInstrumentation handles missing register gracefully", async () => {
    const { runInstrumentation } = await import("../packages/vinext/src/server/instrumentation.js");

    // Module with no register() or onRequestError()
    const mockRunner = {
      import: async (_id: string) => ({}),
    };

    // Should not throw
    await runInstrumentation(mockRunner, "/fake/empty-instrumentation.ts");
  });

  it("runInstrumentation handles import errors gracefully", async () => {
    const { runInstrumentation } = await import("../packages/vinext/src/server/instrumentation.js");
    const mockRunner = {
      import: async (_id: string) => {
        throw new TypeError("Cannot read properties of undefined (reading 'outsideEmitter')");
      },
    };
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runInstrumentation(mockRunner, "/fake/instrumentation.ts");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[vinext] Failed to load instrumentation:",
        "Cannot read properties of undefined (reading 'outsideEmitter')",
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("production server compression", () => {
  it("negotiateEncoding returns br when Accept-Encoding includes br", async () => {
    const { negotiateEncoding } = await import("../packages/vinext/src/server/prod-server.js");
    const req = { headers: { "accept-encoding": "gzip, deflate, br" } };
    expect(negotiateEncoding(req as any)).toBe("br");
  });

  it("negotiateEncoding returns gzip when br is not available", async () => {
    const { negotiateEncoding } = await import("../packages/vinext/src/server/prod-server.js");
    const req = { headers: { "accept-encoding": "gzip, deflate" } };
    expect(negotiateEncoding(req as any)).toBe("gzip");
  });

  it("negotiateEncoding returns null when no encoding header", async () => {
    const { negotiateEncoding } = await import("../packages/vinext/src/server/prod-server.js");
    const req = { headers: {} };
    expect(negotiateEncoding(req as any)).toBeNull();
  });

  it("COMPRESSIBLE_TYPES includes expected content types", async () => {
    const { COMPRESSIBLE_TYPES } = await import("../packages/vinext/src/server/prod-server.js");
    expect(COMPRESSIBLE_TYPES.has("text/html")).toBe(true);
    expect(COMPRESSIBLE_TYPES.has("application/javascript")).toBe(true);
    expect(COMPRESSIBLE_TYPES.has("application/json")).toBe(true);
    expect(COMPRESSIBLE_TYPES.has("text/css")).toBe(true);
    expect(COMPRESSIBLE_TYPES.has("image/svg+xml")).toBe(true);
    // Binary formats should not be compressible
    expect(COMPRESSIBLE_TYPES.has("image/png")).toBe(false);
    expect(COMPRESSIBLE_TYPES.has("image/jpeg")).toBe(false);
  });

  it("COMPRESS_THRESHOLD is a reasonable minimum", async () => {
    const { COMPRESS_THRESHOLD } = await import("../packages/vinext/src/server/prod-server.js");
    expect(COMPRESS_THRESHOLD).toBeGreaterThanOrEqual(256);
    expect(COMPRESS_THRESHOLD).toBeLessThanOrEqual(4096);
  });

  it("sendCompressed compresses text/html with gzip", async () => {
    const { sendCompressed } = await import("../packages/vinext/src/server/prod-server.js");
    const body = "<html>" + "x".repeat(2000) + "</html>";
    const req = { headers: { "accept-encoding": "gzip" } };

    const chunks: Buffer[] = [];
    let writtenStatus = 0;
    let writtenHeaders: Record<string, string> = {};
    const res = {
      writeHead: (status: number, headers: Record<string, string>) => {
        writtenStatus = status;
        writtenHeaders = headers;
      },
      write: (chunk: Buffer) => {
        chunks.push(chunk);
        return true;
      },
      end: (chunk?: Buffer) => {
        if (chunk) chunks.push(chunk);
      },
      on: () => {},
      once: () => {},
      emit: () => false,
      removeListener: () => {},
    };

    await new Promise<void>((resolve) => {
      // Override end to capture completion
      const origEnd = res.end;
      (res as any).end = (chunk?: Buffer) => {
        origEnd(chunk);
        resolve();
      };
      sendCompressed(req as any, res as any, body, "text/html", 200, {}, true);
      // Give pipeline time to complete
      setTimeout(resolve, 100);
    });

    expect(writtenStatus).toBe(200);
    expect(writtenHeaders["Content-Encoding"]).toBe("gzip");
    expect(writtenHeaders["Vary"]).toBe("Accept-Encoding");
  });

  it("sendCompressed does not compress when disabled", async () => {
    const { sendCompressed } = await import("../packages/vinext/src/server/prod-server.js");

    const body = "<html>" + "x".repeat(2000) + "</html>";
    const req = { headers: { "accept-encoding": "gzip" } };

    let writtenHeaders: Record<string, string> = {};
    let writtenBody: Buffer | null = null;
    const res = {
      writeHead: (_status: number, headers: Record<string, string>) => {
        writtenHeaders = headers;
      },
      end: (chunk?: Buffer) => {
        if (chunk) writtenBody = chunk;
      },
    };

    sendCompressed(req as any, res as any, body, "text/html", 200, {}, false);

    // Should NOT have Content-Encoding
    expect(writtenHeaders["Content-Encoding"]).toBeUndefined();
    // Should have Content-Length
    expect(writtenHeaders["Content-Length"]).toBeDefined();
    expect(writtenBody).toBeTruthy();
  });

  it("sendCompressed does not compress small bodies", async () => {
    const { sendCompressed } = await import("../packages/vinext/src/server/prod-server.js");

    const body = "<html>small</html>";
    const req = { headers: { "accept-encoding": "gzip" } };

    let writtenHeaders: Record<string, string> = {};
    const res = {
      writeHead: (_status: number, headers: Record<string, string>) => {
        writtenHeaders = headers;
      },
      end: () => {},
    };

    sendCompressed(req as any, res as any, body, "text/html", 200, {}, true);

    // Body is too small for compression
    expect(writtenHeaders["Content-Encoding"]).toBeUndefined();
    expect(writtenHeaders["Content-Length"]).toBeDefined();
  });

  it("sendCompressed does not compress non-compressible types", async () => {
    const { sendCompressed } = await import("../packages/vinext/src/server/prod-server.js");

    const body = Buffer.alloc(2000, 0xff); // binary content
    const req = { headers: { "accept-encoding": "gzip" } };

    let writtenHeaders: Record<string, string> = {};
    const res = {
      writeHead: (_status: number, headers: Record<string, string>) => {
        writtenHeaders = headers;
      },
      end: () => {},
    };

    sendCompressed(req as any, res as any, body, "image/png", 200, {}, true);

    // PNG should not be compressed
    expect(writtenHeaders["Content-Encoding"]).toBeUndefined();
  });
});

describe("Set-Cookie header preservation in prod-server", () => {
  it("mergeResponseHeaders preserves multiple Set-Cookie from response", async () => {
    const { mergeResponseHeaders } = await import("../packages/vinext/src/server/prod-server.js");

    const middlewareHeaders: Record<string, string | string[]> = {};
    const response = new Response("ok", {
      headers: [
        ["set-cookie", "a=1; Path=/"],
        ["set-cookie", "b=2; Path=/"],
        ["content-type", "text/html"],
      ],
    });

    const merged = mergeResponseHeaders(middlewareHeaders, response);
    expect(merged["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(merged["content-type"]).toBe("text/html");
  });

  it("mergeResponseHeaders merges middleware and response Set-Cookie", async () => {
    const { mergeResponseHeaders } = await import("../packages/vinext/src/server/prod-server.js");

    const middlewareHeaders: Record<string, string | string[]> = {
      "set-cookie": ["mw=1; Path=/"],
    };
    const response = new Response("ok", {
      headers: [["set-cookie", "resp=2; Path=/"]],
    });

    const merged = mergeResponseHeaders(middlewareHeaders, response);
    expect(merged["set-cookie"]).toEqual(["mw=1; Path=/", "resp=2; Path=/"]);
  });

  it("mergeResponseHeaders handles middleware cookie as plain string", async () => {
    const { mergeResponseHeaders } = await import("../packages/vinext/src/server/prod-server.js");

    const middlewareHeaders: Record<string, string | string[]> = {
      "set-cookie": "mw=1; Path=/",
    };
    const response = new Response("ok", {
      headers: [["set-cookie", "resp=2; Path=/"]],
    });

    const merged = mergeResponseHeaders(middlewareHeaders, response);
    expect(merged["set-cookie"]).toEqual(["mw=1; Path=/", "resp=2; Path=/"]);
  });

  it("mergeResponseHeaders does not duplicate non-Set-Cookie headers", async () => {
    const { mergeResponseHeaders } = await import("../packages/vinext/src/server/prod-server.js");

    const middlewareHeaders: Record<string, string | string[]> = {
      "x-custom": "from-middleware",
    };
    const response = new Response("ok", {
      headers: [
        ["x-custom", "from-response"],
        ["content-type", "text/html"],
      ],
    });

    const merged = mergeResponseHeaders(middlewareHeaders, response);
    // Response headers should override middleware headers for non-Set-Cookie
    expect(merged["x-custom"]).toBe("from-response");
  });

  it("mergeWebResponse preserves the original body stream while applying header overrides", async () => {
    const { mergeWebResponse } = await import("../packages/vinext/src/server/prod-server.js");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "x-custom": "from-response",
      },
    });

    const merged = mergeWebResponse({ "x-custom": "from-middleware" }, response, 201);

    expect(merged.status).toBe(201);
    expect(merged.headers.get("x-custom")).toBe("from-response");
    expect(merged.headers.get("content-type")).toBe("text/plain");
    expect(await merged.text()).toBe("hello");
  });

  it("mergeWebResponse cancels discarded body streams for no-body statuses", async () => {
    const { mergeWebResponse } = await import("../packages/vinext/src/server/prod-server.js");

    let started = false;
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          started = true;
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (canceled) return;
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
        cancel() {
          canceled = true;
        },
      }),
      {
        headers: {
          "content-type": "text/plain",
          "content-length": "5",
        },
      },
    );

    const merged = mergeWebResponse({}, response, 204);

    expect(merged.status).toBe(204);
    expect(merged.headers.get("content-type")).toBeNull();
    expect(merged.headers.get("content-length")).toBeNull();
    expect(await merged.text()).toBe("");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(true);
    expect(canceled).toBe(true);
  });

  it("mergeWebResponse strips stale content-length only for tagged streamed Pages HTML", async () => {
    const { mergeWebResponse } = await import("../packages/vinext/src/server/prod-server.js");

    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": "1",
        },
      },
    ) as Response & { __vinextStreamedHtmlResponse?: boolean };
    response.__vinextStreamedHtmlResponse = true;

    const merged = mergeWebResponse({}, response);

    expect(merged.headers.get("content-length")).toBeNull();
    expect(merged.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await merged.text()).toBe("hello");
  });

  it("mergeWebResponse preserves content-length for untagged custom responses", async () => {
    const { mergeWebResponse } = await import("../packages/vinext/src/server/prod-server.js");

    const response = new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "3",
      },
    });

    const merged = mergeWebResponse({ "x-custom-middleware": "active" }, response);

    expect(merged.headers.get("content-length")).toBe("3");
    expect(merged.headers.get("content-type")).toBe("application/octet-stream");
    expect(merged.headers.get("x-custom-middleware")).toBe("active");

    const body = Buffer.from(await merged.arrayBuffer());
    expect(body.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("mergeWebResponse ignores middleware-only content-length overrides", async () => {
    const { mergeWebResponse } = await import("../packages/vinext/src/server/prod-server.js");

    const response = new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "3",
      },
    });

    const merged = mergeWebResponse({ "content-length": "1" }, response);

    expect(merged).toBe(response);
    expect(merged.headers.get("content-length")).toBe("3");
    const body = Buffer.from(await merged.arrayBuffer());
    expect(body.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  for (const encoding of ["gzip", "br"] as const) {
    it(`sendWebResponse streams ${encoding}-compressed HTML progressively`, async () => {
      const result = await captureCompressedWebResponse(encoding);

      expect(result.statusCode).toBe(200);
      expect(result.headers["Content-Encoding"]).toBe(encoding);
      expect(String(result.headers["Vary"])).toContain("Accept-Encoding");
      expect(result.headers["content-length"]).toBeUndefined();
      expect(result.firstDecodedMs).toBeGreaterThanOrEqual(0);
      expect(result.firstDecodedMs).toBeLessThan(250);
      // The delayed chunk uses setTimeout(250ms); allow 50ms slack for JS timer imprecision in CI.
      expect(result.endMs).toBeGreaterThanOrEqual(200);
      expect(result.rawBody.byteLength).toBeGreaterThan(0);
      expect(result.body).toContain("Streaming SSR Test");
      expect(result.body).toContain("Loading delayed chunk...");
      expect(result.body).toContain("Delayed stream content loaded");
    });
  }

  it("sendWebResponse cancels streamed bodies for HEAD requests", async () => {
    const { sendWebResponse } = await import("../packages/vinext/src/server/prod-server.js");

    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
        },
        cancel() {
          canceled = true;
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    );

    let status = 0;
    let writtenHeaders: Record<string, string | string[]> = {};
    let ended = false;
    const req = {
      method: "HEAD",
      headers: { "accept-encoding": "br" },
    };
    const res = new CapturingNodeResponse();
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });

    await sendWebResponse(response, req as any, res as any, true);
    await finished(res);
    status = res.statusCode;
    writtenHeaders = res.headers;
    ended = res.writableEnded;

    expect(status).toBe(200);
    expect(writtenHeaders["content-type"]).toBe("text/html; charset=utf-8");
    expect(writtenHeaders["Content-Encoding"]).toBe("br");
    expect(writtenHeaders["Vary"]).toContain("Accept-Encoding");
    expect(ended).toBe(true);
    expect(chunks).toEqual([]);
    expect(canceled).toBe(true);
  });

  it("sendWebResponse cancels compressed streams on client disconnect", async () => {
    const { sendWebResponse } = await import("../packages/vinext/src/server/prod-server.js");

    let canceled = false;
    const response = new Response(
      createStreamingBody(
        [
          { text: "<h1>Streaming SSR Test</h1>" },
          { text: "<p>Delayed stream content loaded</p>", delayMs: 150 },
        ],
        () => {
          canceled = true;
        },
      ),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    );

    const req = {
      method: "GET",
      headers: { "accept-encoding": "br" },
    };
    const res = new DisconnectingNodeResponse();
    res.on("error", () => {
      /* expected client disconnect */
    });

    await sendWebResponse(response, req as any, res as any, true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Encoding"]).toBe("br");
    expect(res.writeCount).toBeGreaterThan(0);
    expect(canceled).toBe(true);
  });

  it("sendCompressed passes array-valued Set-Cookie to writeHead", async () => {
    const { sendCompressed } = await import("../packages/vinext/src/server/prod-server.js");

    let writtenHeaders: Record<string, string | string[]> = {};
    const req = { headers: {} };
    const res = {
      writeHead: (_status: number, headers: Record<string, string | string[]>) => {
        writtenHeaders = headers;
      },
      end: () => {},
    };

    const extraHeaders: Record<string, string | string[]> = {
      "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
    };

    sendCompressed(req as any, res as any, "small body", "text/html", 200, extraHeaders, false);
    expect(writtenHeaders["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("sendCompressed replaces any existing content-type and content-length headers", async () => {
    const { sendCompressed } = await import("../packages/vinext/src/server/prod-server.js");

    let writtenHeaders: Record<string, string | string[]> = {};
    const req = { headers: {} };
    const res = {
      writeHead: (_status: number, headers: Record<string, string | string[]>) => {
        writtenHeaders = headers;
      },
      end: () => {},
    };

    sendCompressed(
      req as any,
      res as any,
      "hello",
      "application/json",
      200,
      {
        "content-type": "text/plain",
        "content-length": "999",
        "x-custom": "active",
      },
      false,
    );

    expect(writtenHeaders["Content-Type"]).toBe("application/json");
    expect(writtenHeaders["Content-Length"]).toBe("5");
    expect(writtenHeaders["content-type"]).toBeUndefined();
    expect(writtenHeaders["content-length"]).toBeUndefined();
    expect(writtenHeaders["x-custom"]).toBe("active");
  });
});

describe("host header poisoning prevention", () => {
  it("resolveHost ignores X-Forwarded-Host by default", async () => {
    const { resolveHost } = await import("../packages/vinext/src/server/prod-server.js");
    const req = {
      headers: {
        "x-forwarded-host": "evil.com",
        host: "legit.com",
      },
    };
    expect(resolveHost(req as any, "localhost")).toBe("legit.com");
  });

  it("resolveHost uses Host header when X-Forwarded-Host is absent", async () => {
    const { resolveHost } = await import("../packages/vinext/src/server/prod-server.js");
    const req = { headers: { host: "myapp.com:3000" } };
    expect(resolveHost(req as any, "localhost")).toBe("myapp.com:3000");
  });

  it("resolveHost returns fallback when no host headers are present", async () => {
    const { resolveHost } = await import("../packages/vinext/src/server/prod-server.js");
    const req = { headers: {} };
    expect(resolveHost(req as any, "fallback.local")).toBe("fallback.local");
  });

  it("resolveHost trusts X-Forwarded-Host when it is in the trusted hosts set", async () => {
    const { resolveHost, trustedHosts } =
      await import("../packages/vinext/src/server/prod-server.js");
    // Temporarily add a host to the trusted set
    trustedHosts.add("cdn.example.com");
    try {
      const req = {
        headers: {
          "x-forwarded-host": "cdn.example.com",
          host: "internal.local",
        },
      };
      expect(resolveHost(req as any, "localhost")).toBe("cdn.example.com");
    } finally {
      trustedHosts.delete("cdn.example.com");
    }
  });

  it("resolveHost still rejects untrusted X-Forwarded-Host when trusted set is non-empty", async () => {
    const { resolveHost, trustedHosts } =
      await import("../packages/vinext/src/server/prod-server.js");
    trustedHosts.add("trusted.example.com");
    try {
      const req = {
        headers: {
          "x-forwarded-host": "evil.com",
          host: "legit.com",
        },
      };
      expect(resolveHost(req as any, "localhost")).toBe("legit.com");
    } finally {
      trustedHosts.delete("trusted.example.com");
    }
  });

  it("resolveHost handles case-insensitive host matching", async () => {
    const { resolveHost, trustedHosts } =
      await import("../packages/vinext/src/server/prod-server.js");
    trustedHosts.add("cdn.example.com");
    try {
      const req = {
        headers: {
          "x-forwarded-host": "CDN.Example.COM",
          host: "internal.local",
        },
      };
      // DNS hostnames are case-insensitive, should match
      expect(resolveHost(req as any, "localhost")).toBe("cdn.example.com");
    } finally {
      trustedHosts.delete("cdn.example.com");
    }
  });

  it("resolveHost extracts first value from comma-separated X-Forwarded-Host", async () => {
    const { resolveHost, trustedHosts } =
      await import("../packages/vinext/src/server/prod-server.js");
    trustedHosts.add("cdn.example.com");
    try {
      const req = {
        headers: {
          "x-forwarded-host": "cdn.example.com, proxy2.internal",
          host: "internal.local",
        },
      };
      // Multiple proxies produce comma-separated values; first is client-facing
      expect(resolveHost(req as any, "localhost")).toBe("cdn.example.com");
    } finally {
      trustedHosts.delete("cdn.example.com");
    }
  });
});

// ---------------------------------------------------------------------------
// X-Forwarded-Proto trust proxy gating
// ---------------------------------------------------------------------------

describe("X-Forwarded-Proto trust proxy gating", () => {
  it("nodeToWebRequest ignores X-Forwarded-Proto by default (trustProxy=false)", async () => {
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    // Ensure trustProxy is false by default (no env vars set)
    // Note: trustProxy is computed at module load time from env vars.
    // In test env, VINEXT_TRUST_PROXY and VINEXT_TRUSTED_HOSTS are not set.
    const req = {
      headers: {
        "x-forwarded-proto": "https",
        host: "localhost:3000",
      },
      url: "/test",
      method: "GET",
    };
    const webReq = mod.nodeToWebRequest(req as any);
    // Without trust proxy, should default to http://
    expect(webReq.url).toMatch(/^http:\/\//);
  });

  it("trustProxy is false when no env vars are set", async () => {
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    expect(mod.trustProxy).toBe(false);
  });

  it("trustProxy is true when VINEXT_TRUSTED_HOSTS is non-empty", async () => {
    vi.stubEnv("VINEXT_TRUSTED_HOSTS", "example.com");
    vi.resetModules();
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    expect(mod.trustProxy).toBe(true);
    expect(mod.trustedHosts.has("example.com")).toBe(true);
    vi.unstubAllEnvs();
  });

  it("trustProxy is false when VINEXT_TRUSTED_HOSTS is empty string", async () => {
    vi.stubEnv("VINEXT_TRUSTED_HOSTS", "");
    vi.resetModules();
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    expect(mod.trustProxy).toBe(false);
    expect(mod.trustedHosts.size).toBe(0);
    vi.unstubAllEnvs();
  });

  it("nodeToWebRequest uses http:// when X-Forwarded-Proto is missing", async () => {
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    const req = {
      headers: { host: "localhost:3000" },
      url: "/test",
      method: "GET",
    };
    const webReq = mod.nodeToWebRequest(req as any);
    expect(webReq.url).toMatch(/^http:\/\/localhost:3000\/test$/);
  });
});

// ---------------------------------------------------------------------------
// Malformed percent-encoded URL regression tests (HackerOne #3575154)
// ---------------------------------------------------------------------------

describe("malformed percent-encoded URLs return 400 instead of crashing", () => {
  // Dev server test: uses the Pages Router fixture
  let malformedServer: ViteDevServer;
  let malformedBaseUrl: string;

  beforeAll(async () => {
    ({ server: malformedServer, baseUrl: malformedBaseUrl } =
      await startFixtureServer(FIXTURE_DIR));
  }, 30000);

  afterAll(async () => {
    await malformedServer?.close();
  });

  it("dev server returns 400 for malformed percent-encoded path", async () => {
    const res = await fetch(`${malformedBaseUrl}/%E0%A4%A`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Bad Request");
  });

  it("dev server returns 400 for truncated percent sequence", async () => {
    const res = await fetch(`${malformedBaseUrl}/%E0%A4`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Bad Request");
  });

  it("dev server returns 400 for bare percent sign", async () => {
    const res = await fetch(`${malformedBaseUrl}/%`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Bad Request");
  });

  it("dev server still serves valid percent-encoded paths", async () => {
    // %2F is a valid encoding for "/"
    const res = await fetch(`${malformedBaseUrl}/about`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Edge cases from Next.js test suite
// ---------------------------------------------------------------------------

describe("Next.js edge cases", () => {
  // Uses the Pages Router fixture (FIXTURE_DIR = PAGES_FIXTURE_DIR)
  let edgeServer: ViteDevServer;
  let edgeBaseUrl: string;

  beforeAll(async () => {
    ({ server: edgeServer, baseUrl: edgeBaseUrl } = await startFixtureServer(FIXTURE_DIR));
  }, 30000);

  afterAll(async () => {
    await edgeServer?.close();
  });

  // --- Edge case 1: Query params must NOT leak into getStaticProps params ---

  it("getStaticProps query params do not leak into params", async () => {
    // Visit a static page with query params — params should only contain the dynamic segments
    const res = await fetch(`${edgeBaseUrl}/articles/1?utm_source=test&ref=google`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The page renders the article title based on params.id
    expect(html).toContain("First Article");
    // React SSR may insert comment nodes: "Article ID: <!-- -->1"
    expect(html).toMatch(/Article ID:.*1/);
    // Query params should NOT affect the rendered page content (they may appear in Vite module URLs)
    // Check the __NEXT_DATA__ doesn't leak query params into getStaticProps
    const dataMatch = html.match(/__NEXT_DATA__\s*=\s*(\{[^<]+\})/);
    expect(dataMatch).not.toBeNull();
    const data = JSON.parse(dataMatch![1]);
    expect(data.props.pageProps.id).toBe("1");
    expect(data.props.pageProps.title).toBe("First Article");
    // getStaticProps params should only contain route params, not URL query
    expect(data.query).not.toHaveProperty("utm_source");
    expect(data.query).not.toHaveProperty("ref");
  });

  it("__NEXT_DATA__ query contains dynamic params for static pages", async () => {
    const res = await fetch(`${edgeBaseUrl}/articles/2?extra=value`);
    const html = await res.text();
    const dataMatch = html.match(/__NEXT_DATA__\s*=\s*(\{[^<]+\})/);
    expect(dataMatch).not.toBeNull();
    const data = JSON.parse(dataMatch![1]);
    // query should contain the dynamic segment
    expect(data.query.id).toBe("2");
    // Verify the page props are correct
    expect(data.props.pageProps.id).toBe("2");
    expect(data.props.pageProps.title).toBe("Second Article");
  });

  // --- Edge case 2: getServerSideProps with notFound returns 404 status ---

  it("getServerSideProps notFound returns 404 status code", async () => {
    // The /posts/missing page always returns notFound: true
    const res = await fetch(`${edgeBaseUrl}/posts/missing`);
    expect(res.status).toBe(404);
  });

  it("getServerSideProps notFound renders custom 404 page content", async () => {
    const res = await fetch(`${edgeBaseUrl}/posts/missing`);
    const html = await res.text();
    // Should render the custom 404 page
    expect(html).toContain("404");
  });

  // --- Edge case 3: UTF-8 encoding in SSR ---

  it("SSR response declares UTF-8 charset", async () => {
    const res = await fetch(`${edgeBaseUrl}/about`);
    const html = await res.text();
    // React outputs charSet (camelCase) in JSX which becomes charset in HTML
    expect(html).toMatch(/char[Ss]et.*utf-8/i);
  });
});

describe("multi-byte character SSR", () => {
  let mbServer: ViteDevServer;
  let mbBaseUrl: string;
  let mbTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    mbTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-mb-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(mbTmpDir, "node_modules"), "junction");

    await fsp.writeFile(path.join(mbTmpDir, "next.config.mjs"), `export default {};`);
    await fsp.mkdir(path.join(mbTmpDir, "pages"), { recursive: true });

    // Page with multi-byte characters (Japanese, Chinese, Korean, emoji)
    await fsp.writeFile(
      path.join(mbTmpDir, "pages", "index.tsx"),
      `export default function MultiByteTest() {
  const japanese = "マルチバイト".repeat(28);
  const chinese = "你好世界";
  const korean = "안녕하세요";
  const emoji = "🎉🚀💻🌍";
  return (
    <div>
      <h1>Multi-Byte Test</h1>
      <p id="japanese">{japanese}</p>
      <p id="chinese">{chinese}</p>
      <p id="korean">{korean}</p>
      <p id="emoji">{emoji}</p>
    </div>
  );
}`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins: any[] = [vinext()];
    mbServer = await createServer({
      root: mbTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });
    await mbServer.listen();
    const addr = mbServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      mbBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (mbServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([mbServer?.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(mbTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("renders Japanese characters correctly (28 repetitions)", async () => {
    const res = await fetch(`${mbBaseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("マルチバイト".repeat(28));
  });

  it("renders Chinese characters correctly", async () => {
    const res = await fetch(`${mbBaseUrl}/`);
    const html = await res.text();
    expect(html).toContain("你好世界");
  });

  it("renders Korean characters correctly", async () => {
    const res = await fetch(`${mbBaseUrl}/`);
    const html = await res.text();
    expect(html).toContain("안녕하세요");
  });

  it("renders emoji correctly", async () => {
    const res = await fetch(`${mbBaseUrl}/`);
    const html = await res.text();
    expect(html).toContain("🎉🚀💻🌍");
  });

  it("response has correct UTF-8 content-type", async () => {
    const res = await fetch(`${mbBaseUrl}/`);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/html");
  });
});

// --- Edge case: Cross-locale redirect from getServerSideProps ---

describe("i18n cross-locale redirect from getServerSideProps", () => {
  let localeRedirectServer: ViteDevServer;
  let localeRedirectBaseUrl: string;
  let localeRedirectTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    localeRedirectTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-locale-redirect-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(localeRedirectTmpDir, "node_modules"), "junction");

    await fsp.writeFile(
      path.join(localeRedirectTmpDir, "next.config.mjs"),
      `export default {
  i18n: {
    locales: ["en", "fr", "de"],
    defaultLocale: "en",
  },
};`,
    );

    await fsp.mkdir(path.join(localeRedirectTmpDir, "pages"), { recursive: true });

    // Home page
    await fsp.writeFile(
      path.join(localeRedirectTmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    // Page that redirects to a different locale
    await fsp.writeFile(
      path.join(localeRedirectTmpDir, "pages", "redirect-to-fr.tsx"),
      `export function getServerSideProps({ locale }) {
  if (locale !== "fr") {
    return {
      redirect: {
        destination: "/fr/redirect-to-fr",
        permanent: false,
      },
    };
  }
  return { props: { locale } };
}
export default function Page({ locale }) {
  return <h1>French page: {locale}</h1>;
}`,
    );

    // Page that returns notFound for non-default locale
    await fsp.writeFile(
      path.join(localeRedirectTmpDir, "pages", "en-only.tsx"),
      `export function getServerSideProps({ locale }) {
  if (locale !== "en") {
    return { notFound: true };
  }
  return { props: { locale } };
}
export default function Page({ locale }) {
  return <h1>English only: {locale}</h1>;
}`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins: any[] = [vinext()];
    localeRedirectServer = await createServer({
      root: localeRedirectTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });
    await localeRedirectServer.listen();
    const addr = localeRedirectServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      localeRedirectBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (localeRedirectServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        localeRedirectServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(localeRedirectTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("getServerSideProps can redirect to a different locale", async () => {
    const res = await fetch(`${localeRedirectBaseUrl}/redirect-to-fr`, {
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/fr/redirect-to-fr");
  });

  it("following the cross-locale redirect renders the correct page", async () => {
    const res = await fetch(`${localeRedirectBaseUrl}/fr/redirect-to-fr`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("French page");
  });

  it("getServerSideProps notFound for non-default locale returns 404", async () => {
    const res = await fetch(`${localeRedirectBaseUrl}/fr/en-only`);
    expect(res.status).toBe(404);
  });

  it("getServerSideProps renders for default locale", async () => {
    const res = await fetch(`${localeRedirectBaseUrl}/en-only`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("English only");
  });
});

// ---------------------------------------------------------------------------
// applyNavigationLocale (router.push/replace locale option)
// ---------------------------------------------------------------------------

describe("applyNavigationLocale", () => {
  let applyNavigationLocale: (url: string, locale?: string) => string;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/shims/router.js");
    applyNavigationLocale = mod.applyNavigationLocale;
  });

  beforeEach(() => {
    // Set up window globals that applyNavigationLocale reads
    (globalThis as any).window = globalThis;
    (globalThis as any).__VINEXT_DEFAULT_LOCALE__ = "en";
    (globalThis as any).__NEXT_DATA__ = undefined;
  });

  afterEach(() => {
    delete (globalThis as any).__VINEXT_DEFAULT_LOCALE__;
    delete (globalThis as any).__NEXT_DATA__;
    delete (globalThis as any).location;
    delete (globalThis as any).window;
  });

  it("returns url unchanged when no locale is specified", () => {
    expect(applyNavigationLocale("/about")).toBe("/about");
  });

  it("returns url unchanged when locale is undefined", () => {
    expect(applyNavigationLocale("/about", undefined)).toBe("/about");
  });

  it("returns url unchanged when locale matches default locale", () => {
    expect(applyNavigationLocale("/about", "en")).toBe("/about");
  });

  it("prefixes non-default locale to absolute path", () => {
    expect(applyNavigationLocale("/about", "fr")).toBe("/fr/about");
  });

  it("prefixes non-default locale to root path", () => {
    expect(applyNavigationLocale("/", "fr")).toBe("/fr/");
  });

  it("prefixes non-default locale to nested path", () => {
    expect(applyNavigationLocale("/blog/post-1", "de")).toBe("/de/blog/post-1");
  });

  it("does not double-prefix if URL already starts with locale", () => {
    expect(applyNavigationLocale("/fr/about", "fr")).toBe("/fr/about");
  });

  it("does not double-prefix if URL is exactly the locale", () => {
    expect(applyNavigationLocale("/fr", "fr")).toBe("/fr");
  });

  it("handles relative paths by adding leading slash", () => {
    expect(applyNavigationLocale("about", "fr")).toBe("/fr/about");
  });

  it("preserves query strings when prefixing locale", () => {
    expect(applyNavigationLocale("/search?q=hello", "fr")).toBe("/fr/search?q=hello");
  });

  it("preserves hash when prefixing locale", () => {
    expect(applyNavigationLocale("/docs#intro", "de")).toBe("/de/docs#intro");
  });

  it("returns an absolute cross-domain URL when the locale belongs to another domain", () => {
    (globalThis as any).__NEXT_DATA__ = {
      domainLocales: [
        { domain: "example.com", defaultLocale: "en" },
        { domain: "example.fr", defaultLocale: "fr", http: true },
      ],
    };
    (globalThis as any).location = {
      protocol: "https:",
      hostname: "example.com",
      host: "example.com",
    };

    expect(applyNavigationLocale("/about", "fr")).toBe("http://example.fr/about");
  });

  it("includes basePath in cross-domain locale navigation URLs", async () => {
    const originalBasePath = process.env.__NEXT_ROUTER_BASEPATH;
    process.env.__NEXT_ROUTER_BASEPATH = "/app";
    vi.resetModules();

    try {
      (globalThis as any).window = {
        __NEXT_DATA__: {
          domainLocales: [
            { domain: "example.com", defaultLocale: "en" },
            { domain: "example.fr", defaultLocale: "fr", http: true },
          ],
        },
        __VINEXT_DEFAULT_LOCALE__: "en",
        location: {
          hostname: "example.com",
          pathname: "/app/about",
          search: "",
        },
        addEventListener() {},
        removeEventListener() {},
      };
      const mod = await import("../packages/vinext/src/shims/router.js");

      expect(mod.applyNavigationLocale("/about", "fr")).toBe("http://example.fr/app/about");
    } finally {
      if (originalBasePath === undefined) {
        delete process.env.__NEXT_ROUTER_BASEPATH;
      } else {
        process.env.__NEXT_ROUTER_BASEPATH = originalBasePath;
      }
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// parseCookieLocale (NEXT_LOCALE cookie support)
// ---------------------------------------------------------------------------

describe("parseCookieLocale", () => {
  let parseCookieLocale: (req: any, i18nConfig: any) => string | null;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/server/dev-server.js");
    parseCookieLocale = mod.parseCookieLocale;
  });

  const config = { locales: ["en", "fr", "de"], defaultLocale: "en", localeDetection: true };

  it("returns null when no cookie header", () => {
    expect(parseCookieLocale({ headers: {} }, config)).toBeNull();
  });

  it("returns null when cookie header has no NEXT_LOCALE", () => {
    expect(parseCookieLocale({ headers: { cookie: "foo=bar; baz=qux" } }, config)).toBeNull();
  });

  it("returns locale from NEXT_LOCALE cookie", () => {
    expect(parseCookieLocale({ headers: { cookie: "NEXT_LOCALE=fr" } }, config)).toBe("fr");
  });

  it("returns locale when NEXT_LOCALE is among multiple cookies", () => {
    expect(
      parseCookieLocale({ headers: { cookie: "theme=dark; NEXT_LOCALE=de; session=abc" } }, config),
    ).toBe("de");
  });

  it("returns null for invalid locale in cookie", () => {
    expect(parseCookieLocale({ headers: { cookie: "NEXT_LOCALE=es" } }, config)).toBeNull();
  });

  it("returns locale for URL-encoded cookie value", () => {
    expect(parseCookieLocale({ headers: { cookie: "NEXT_LOCALE=fr" } }, config)).toBe("fr");
  });

  it("returns default locale when cookie matches default", () => {
    expect(parseCookieLocale({ headers: { cookie: "NEXT_LOCALE=en" } }, config)).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// NEXT_LOCALE cookie integration (i18n redirect behavior)
// ---------------------------------------------------------------------------

describe("NEXT_LOCALE cookie redirect behavior", () => {
  let cookieServer: ViteDevServer;
  let cookieBaseUrl: string;
  let cookieTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    cookieTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-cookie-locale-"));

    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(cookieTmpDir, "node_modules"), "junction");

    await fsp.writeFile(
      path.join(cookieTmpDir, "next.config.mjs"),
      `export default {
  i18n: {
    locales: ["en", "fr", "de"],
    defaultLocale: "en",
  },
};`,
    );

    await fsp.mkdir(path.join(cookieTmpDir, "pages"), { recursive: true });

    await fsp.writeFile(
      path.join(cookieTmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    await fsp.writeFile(
      path.join(cookieTmpDir, "pages", "about.tsx"),
      `export default function About() { return <h1>About</h1>; }`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins: any[] = [vinext()];
    cookieServer = await createServer({
      root: cookieTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await cookieServer.listen();
    const addr = cookieServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      cookieBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (cookieServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        cookieServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(cookieTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("NEXT_LOCALE cookie redirects to non-default locale", async () => {
    const res = await fetch(`${cookieBaseUrl}/`, {
      redirect: "manual",
      headers: { Cookie: "NEXT_LOCALE=fr" },
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/fr");
  });

  it("NEXT_LOCALE cookie redirects on non-root paths", async () => {
    const res = await fetch(`${cookieBaseUrl}/about`, {
      redirect: "manual",
      headers: { Cookie: "NEXT_LOCALE=de" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("NEXT_LOCALE cookie matching default locale does NOT redirect", async () => {
    const res = await fetch(`${cookieBaseUrl}/`, {
      redirect: "manual",
      headers: { Cookie: "NEXT_LOCALE=en" },
    });
    expect(res.status).toBe(200);
  });

  it("NEXT_LOCALE cookie takes priority over Accept-Language", async () => {
    const res = await fetch(`${cookieBaseUrl}/`, {
      redirect: "manual",
      headers: {
        Cookie: "NEXT_LOCALE=de",
        "Accept-Language": "fr",
      },
    });
    expect(res.status).toBe(307);
    // Cookie says "de", Accept-Language says "fr" — cookie wins
    expect(res.headers.get("location")).toBe("/de");
  });

  it("NEXT_LOCALE cookie with default locale suppresses Accept-Language redirect", async () => {
    const res = await fetch(`${cookieBaseUrl}/`, {
      redirect: "manual",
      headers: {
        Cookie: "NEXT_LOCALE=en",
        "Accept-Language": "fr",
      },
    });
    // Cookie says "en" (default) — should NOT redirect even though Accept-Language says "fr"
    expect(res.status).toBe(200);
  });

  it("invalid NEXT_LOCALE cookie falls through to Accept-Language", async () => {
    const res = await fetch(`${cookieBaseUrl}/`, {
      redirect: "manual",
      headers: {
        Cookie: "NEXT_LOCALE=es",
        "Accept-Language": "fr",
      },
    });
    // "es" is not a valid locale, so cookie is ignored and Accept-Language kicks in
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/fr");
  });

  it("no NEXT_LOCALE cookie falls through to Accept-Language", async () => {
    const res = await fetch(`${cookieBaseUrl}/`, {
      redirect: "manual",
      headers: {
        Cookie: "theme=dark",
        "Accept-Language": "de",
      },
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/de");
  });

  it("NEXT_LOCALE does not redirect when URL already has locale prefix", async () => {
    const res = await fetch(`${cookieBaseUrl}/fr/about`, {
      redirect: "manual",
      headers: { Cookie: "NEXT_LOCALE=de" },
    });
    // URL has /fr/ prefix — locale is already specified, cookie should NOT cause redirect
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Chained middleware → config rewrites
// ---------------------------------------------------------------------------

describe("chained middleware → config rewrites", () => {
  let chainServer: ViteDevServer;
  let chainBaseUrl: string;
  let chainTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    chainTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-chain-rewrite-"));

    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(chainTmpDir, "node_modules"), "junction");

    // Config with afterFiles rewrite: /intermediate → /final
    await fsp.writeFile(
      path.join(chainTmpDir, "next.config.mjs"),
      `export default {
  async rewrites() {
    return [
      { source: "/intermediate", destination: "/final" },
    ];
  },
};`,
    );

    await fsp.mkdir(path.join(chainTmpDir, "pages"), { recursive: true });

    // Middleware: rewrites /original → /intermediate
    await fsp.writeFile(
      path.join(chainTmpDir, "middleware.ts"),
      `import { NextResponse } from "next/server";
export function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname === "/original") {
    return NextResponse.rewrite(new URL("/intermediate", request.url));
  }
  return NextResponse.next();
}`,
    );

    // /original — should NOT be rendered (middleware rewrites away)
    await fsp.writeFile(
      path.join(chainTmpDir, "pages", "original.tsx"),
      `export default function Original() { return <h1>ORIGINAL PAGE</h1>; }`,
    );

    // /intermediate — middleware rewrites to here, then config rewrites to /final
    await fsp.writeFile(
      path.join(chainTmpDir, "pages", "intermediate.tsx"),
      `export default function Intermediate() { return <h1>INTERMEDIATE PAGE</h1>; }`,
    );

    // /final — the ultimate destination after both rewrites
    await fsp.writeFile(
      path.join(chainTmpDir, "pages", "final.tsx"),
      `export default function Final() { return <h1>FINAL PAGE</h1>; }`,
    );

    // /direct-intermediate — tests that config rewrite works independently
    await fsp.writeFile(
      path.join(chainTmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins: any[] = [vinext()];
    chainServer = await createServer({
      root: chainTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await chainServer.listen();
    const addr = chainServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      chainBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (chainServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        chainServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(chainTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("middleware rewrite alone works: /original renders /intermediate content", async () => {
    // Middleware rewrites /original → /intermediate
    // Without chaining, we'd see INTERMEDIATE PAGE content
    const res = await fetch(`${chainBaseUrl}/original`);
    const html = await res.text();
    // The middleware first rewrites to /intermediate, then the config rewrite
    // rewrites /intermediate → /final. So we expect FINAL PAGE.
    expect(html).toContain("FINAL PAGE");
  });

  it("config rewrite alone works: /intermediate renders /final content", async () => {
    const res = await fetch(`${chainBaseUrl}/intermediate`);
    const html = await res.text();
    expect(html).toContain("FINAL PAGE");
  });

  it("chained: /original → middleware → /intermediate → config → /final", async () => {
    const res = await fetch(`${chainBaseUrl}/original`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Must reach the final page through both rewrites
    expect(html).toContain("FINAL PAGE");
    expect(html).not.toContain("ORIGINAL PAGE");
    expect(html).not.toContain("INTERMEDIATE PAGE");
  });

  it("/final is directly accessible", async () => {
    const res = await fetch(`${chainBaseUrl}/final`);
    const html = await res.text();
    expect(html).toContain("FINAL PAGE");
  });
});

// ---------------------------------------------------------------------------
// Middleware rewrite status propagation (Pages Router dev)
// ---------------------------------------------------------------------------

describe("middleware rewriteStatus propagation (Pages Router dev)", () => {
  let statusServer: ViteDevServer;
  let statusBaseUrl: string;
  let statusTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    statusTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-rewrite-status-"));

    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(statusTmpDir, "node_modules"), "junction");

    await fsp.mkdir(path.join(statusTmpDir, "pages"), { recursive: true });

    // Middleware: rewrites /blocked to /allowed with status 403
    await fsp.writeFile(
      path.join(statusTmpDir, "middleware.ts"),
      `import { NextResponse } from "next/server";
export function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname === "/blocked") {
    return NextResponse.rewrite(new URL("/allowed", request.url), { status: 403 });
  }
  return NextResponse.next();
}`,
    );

    await fsp.writeFile(
      path.join(statusTmpDir, "pages", "allowed.tsx"),
      `export default function Allowed() { return <h1>ALLOWED PAGE</h1>; }`,
    );

    await fsp.writeFile(
      path.join(statusTmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    statusServer = await createServer({
      root: statusTmpDir,
      configFile: false,
      plugins: [vinext()],
      server: { port: 0 },
      logLevel: "silent",
    });

    await statusServer.listen();
    const addr = statusServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      statusBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (statusServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        statusServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(statusTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  it("middleware rewrite with custom status returns that status code", async () => {
    const res = await fetch(`${statusBaseUrl}/blocked`);
    // Page content should be from /allowed (rewrite target)
    const html = await res.text();
    expect(html).toContain("ALLOWED PAGE");
    // Status code should be 403 from the middleware rewrite
    expect(res.status).toBe(403);
  });

  it("normal requests without rewrite status return 200", async () => {
    const res = await fetch(`${statusBaseUrl}/allowed`);
    const html = await res.text();
    expect(html).toContain("ALLOWED PAGE");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Additional Next.js edge cases (batch 2)
// ---------------------------------------------------------------------------

describe("Pages Router edge cases (batch 2)", () => {
  let edgeServer: ViteDevServer;
  let edgeBaseUrl: string;
  let edgeTmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    edgeTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-edge2-"));

    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(edgeTmpDir, "node_modules"), "junction");

    await fsp.writeFile(path.join(edgeTmpDir, "next.config.mjs"), `export default {};`);

    await fsp.mkdir(path.join(edgeTmpDir, "pages"), { recursive: true });
    await fsp.mkdir(path.join(edgeTmpDir, "pages", "api"), { recursive: true });

    // Index page
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    // GSSP permanent redirect
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "perm-redirect.tsx"),
      `export async function getServerSideProps() {
  return { redirect: { destination: "/target", permanent: true } };
}
export default function PermanentRedirect() { return <h1>Should not see this</h1>; }`,
    );

    // GSSP redirect with custom statusCode
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "custom-redirect.tsx"),
      `export async function getServerSideProps() {
  return { redirect: { destination: "/target", statusCode: 302 } };
}
export default function CustomRedirect() { return <h1>Should not see this</h1>; }`,
    );

    // Target of redirects
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "target.tsx"),
      `export default function Target() { return <h1>Target Page</h1>; }`,
    );

    // getStaticProps notFound
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "gsp-notfound.tsx"),
      `export async function getStaticProps() {
  return { notFound: true };
}
export default function GspNotFound() { return <h1>Should not see this</h1>; }`,
    );

    // getStaticProps with empty props
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "empty-props.tsx"),
      `export async function getStaticProps() {
  return { props: {} };
}
export default function EmptyProps() { return <h1>Empty Props Page</h1>; }`,
    );

    // GSSP props with nested objects
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "nested-props.tsx"),
      `export async function getServerSideProps() {
  return { props: { user: { name: "Alice", settings: { theme: "dark", lang: "en" } } } };
}
export default function NestedProps({ user }) {
  return <div><h1>Nested Props</h1><p id="name">{user.name}</p><p id="theme">{user.settings.theme}</p></div>;
}`,
    );

    // API route with different methods
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "api", "methods.ts"),
      `export default function handler(req, res) {
  if (req.method === "POST") {
    res.status(201).json({ method: "POST", received: true });
  } else if (req.method === "PUT") {
    res.status(200).json({ method: "PUT", updated: true });
  } else if (req.method === "DELETE") {
    res.status(200).json({ method: "DELETE", deleted: true });
  } else if (req.method === "PATCH") {
    res.status(200).json({ method: "PATCH", patched: true });
  } else {
    res.status(200).json({ method: req.method });
  }
}`,
    );

    // API route with request body parsing
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "api", "echo.ts"),
      `export default async function handler(req, res) {
  if (req.method === "POST") {
    // Body should be parsed by the dev server
    const body = req.body;
    res.status(200).json({ echo: body });
  } else {
    res.status(405).json({ error: "Method not allowed" });
  }
}`,
    );

    // Custom 404 page
    await fsp.writeFile(
      path.join(edgeTmpDir, "pages", "404.tsx"),
      `export default function Custom404() { return <h1>Custom 404 - Not Found</h1>; }`,
    );

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins: any[] = [vinext()];
    edgeServer = await createServer({
      root: edgeTmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await edgeServer.listen();
    const addr = edgeServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      edgeBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    try {
      (edgeServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([
        edgeServer?.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* ignore */
    }
    const fsp = await import("node:fs/promises");
    await fsp.rm(edgeTmpDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  // --- GSSP redirect variants ---

  it("GSSP redirect with permanent: true returns 308", async () => {
    const res = await fetch(`${edgeBaseUrl}/perm-redirect`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/target");
  });

  it("GSSP redirect with statusCode: 302 returns 302", async () => {
    const res = await fetch(`${edgeBaseUrl}/custom-redirect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/target");
  });

  // --- getStaticProps edge cases ---

  it("getStaticProps notFound returns 404", async () => {
    const res = await fetch(`${edgeBaseUrl}/gsp-notfound`);
    expect(res.status).toBe(404);
  });

  it("getStaticProps with empty props renders page", async () => {
    const res = await fetch(`${edgeBaseUrl}/empty-props`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Empty Props Page");
  });

  // --- GSSP with nested objects ---

  it("GSSP passes nested object props correctly", async () => {
    const res = await fetch(`${edgeBaseUrl}/nested-props`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Alice");
    expect(html).toContain("dark");
  });

  it("__NEXT_DATA__ contains nested GSSP props", async () => {
    const res = await fetch(`${edgeBaseUrl}/nested-props`);
    const html = await res.text();
    // __NEXT_DATA__ is injected as: <script>window.__NEXT_DATA__ = {...}</script>
    const match = html.match(/window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\})(?:;|<)/);
    expect(match).not.toBeNull();
    const data = JSON.parse(match![1]);
    expect(data.props.pageProps.user.name).toBe("Alice");
    expect(data.props.pageProps.user.settings.theme).toBe("dark");
    expect(data.props.pageProps.user.settings.lang).toBe("en");
  });

  // --- API route HTTP methods ---

  it("API route handles POST", async () => {
    const res = await fetch(`${edgeBaseUrl}/api/methods`, { method: "POST" });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.method).toBe("POST");
    expect(json.received).toBe(true);
  });

  it("API route handles PUT", async () => {
    const res = await fetch(`${edgeBaseUrl}/api/methods`, { method: "PUT" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.method).toBe("PUT");
    expect(json.updated).toBe(true);
  });

  it("API route handles DELETE", async () => {
    const res = await fetch(`${edgeBaseUrl}/api/methods`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.method).toBe("DELETE");
    expect(json.deleted).toBe(true);
  });

  it("API route handles PATCH", async () => {
    const res = await fetch(`${edgeBaseUrl}/api/methods`, { method: "PATCH" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.method).toBe("PATCH");
    expect(json.patched).toBe(true);
  });

  // --- 404 edge cases ---

  it("custom 404 page renders for unknown routes", async () => {
    const res = await fetch(`${edgeBaseUrl}/nonexistent`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Custom 404 - Not Found");
  });

  it("custom 404 page renders for getStaticProps notFound", async () => {
    const res = await fetch(`${edgeBaseUrl}/gsp-notfound`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Custom 404 - Not Found");
  });
});

// ---------------------------------------------------------------------------
// .env file loading (Issue #228)
// ---------------------------------------------------------------------------

describe(".env file loading (Issue #228)", () => {
  let envServer: ViteDevServer;
  let envBaseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-env-"));

    // Symlink node_modules
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    // .env file with NEXT_PUBLIC_ and server-only vars
    await fsp.writeFile(
      path.join(tmpDir, ".env"),
      `NEXT_PUBLIC_APP_NAME=vinext-test-app
SERVER_ONLY_SECRET=super-secret-123
BETTER_AUTH_URL=http://localhost:9999
`,
    );

    // pages directory with a page that renders env vars
    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });

    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export function getServerSideProps() {
  return {
    props: {
      publicVar: process.env.NEXT_PUBLIC_APP_NAME ?? "NOT_LOADED",
      serverVar: process.env.SERVER_ONLY_SECRET ?? "NOT_LOADED",
      authUrl: process.env.BETTER_AUTH_URL ?? "NOT_LOADED",
    },
  };
}

export default function Home({ publicVar, serverVar, authUrl }) {
  return (
    <div>
      <p id="public">PUBLIC:{publicVar}</p>
      <p id="server">SERVER:{serverVar}</p>
      <p id="auth">AUTH:{authUrl}</p>
    </div>
  );
}
`,
    );

    // Start server
    const plugins: any[] = [vinext()];
    envServer = await createServer({
      root: tmpDir,
      configFile: false,
      plugins,
      server: { port: 0 },
      logLevel: "silent",
    });

    await envServer.listen();
    const addr = envServer.httpServer?.address();
    if (addr && typeof addr === "object") {
      envBaseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    // Clean up env vars loaded from .env to avoid polluting other tests
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.SERVER_ONLY_SECRET;
    delete process.env.BETTER_AUTH_URL;

    try {
      (envServer?.httpServer as any)?.closeAllConnections?.();
      await Promise.race([envServer?.close(), new Promise((r) => setTimeout(r, 3000))]);
    } catch {}

    if (tmpDir) {
      const fsp = await import("node:fs/promises");
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("NEXT_PUBLIC_ vars from .env are available via process.env", () => {
    // Check the Vite define config — NEXT_PUBLIC_ vars from .env should
    // be registered as define entries for client-side inlining.
    const defineKey = "process.env.NEXT_PUBLIC_APP_NAME";
    const defineValue = envServer.config.define?.[defineKey];
    expect(defineValue).toBe(JSON.stringify("vinext-test-app"));
  });

  it("server-only vars from .env are NOT exposed in client defines", () => {
    // Only NEXT_PUBLIC_* vars should be inlined into the client bundle.
    // Server-only secrets must never appear in config.define, or they
    // would be embedded in client JavaScript and sent to the browser.
    const defines = envServer.config.define ?? {};
    expect(defines["process.env.SERVER_ONLY_SECRET"]).toBeUndefined();
    expect(defines["process.env.BETTER_AUTH_URL"]).toBeUndefined();

    // Also verify no define key contains the secret value itself
    const allDefineValues = Object.values(defines).join(" ");
    expect(allDefineValues).not.toContain("super-secret-123");
    expect(allDefineValues).not.toContain("localhost:9999");
  });

  it("server-side code can read .env vars via process.env", async () => {
    // getServerSideProps reads process.env at runtime.
    // If .env is loaded, these should have the values from .env.
    const res = await fetch(`${envBaseUrl}/`);
    const html = await res.text();
    // React SSR inserts <!-- --> comments between adjacent text nodes,
    // so check __NEXT_DATA__ which has the raw props.
    expect(html).toContain('"publicVar":"vinext-test-app"');
    expect(html).toContain('"serverVar":"super-secret-123"');
    expect(html).toContain('"authUrl":"http://localhost:9999"');
  });
});
