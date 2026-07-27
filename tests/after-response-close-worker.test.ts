/**
 * Metadata file convention responses (robots(), sitemap(), manifest(),
 * static icons) serialize their body to a string or byte array with no
 * producer left, so `closeAfterResponseWithBody()` marks them
 * (`markFullyBufferedBody`) and skips the close-tracking wrap when no
 * `after()` work is pending — letting the runtime send an accurate
 * `Content-Length` instead of chunked transfer encoding. Hand-written Route
 * Handler responses are not marked, since they may be `new Response(stream)`
 * still producing, and keep close tracking.
 *
 * Runs inside the actual Cloudflare Workers runtime (via wrangler's workerd):
 * `Content-Length` is a wire-level artifact of the runtime's own
 * serialization, invisible on an in-memory Headers object and not produced
 * the same way by every transport (Vite's Node dev server, for example,
 * always streams regardless of this code path).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR, createIsolatedFixture } from "./helpers.js";

const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules",
);

type CloudflarePluginFactory = (options: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options?: { intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 100;
  const deadline = Date.now() + (options?.timeoutMs ?? 3000);
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("closeAfterResponseWithBody on the Cloudflare Workers runtime", () => {
  let root = "";
  let worker: { url: Promise<URL>; dispose(): Promise<void> } | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await createIsolatedFixture(
      APP_FIXTURE_DIR,
      "vinext-after-response-close-worker-",
      // createIsolatedFixture swaps in a plain workspace node_modules symlink
      // (here, cf-app-basic's, for @cloudflare/vite-plugin + wrangler), which
      // drops app-basic's own `file:./__test_packages__/*` local packages.
      // Exclude the two routes that depend on those — unrelated to this
      // regression — so the rest of the fixture still builds.
      (src) =>
        !src.includes(`${path.sep}app${path.sep}context-dedup-test`) &&
        !src.includes(`${path.sep}app${path.sep}nextjs-compat${path.sep}node-modules-css`),
      CLOUDFLARE_NODE_MODULES,
    );
    // app-basic has no wrangler config of its own (it's normally only used
    // for Vite/Node-mode tests) — write a minimal one so @cloudflare/vite-plugin
    // emits dist/server/wrangler.json for unstable_startWorker to read.
    await fs.writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "vinext-after-response-close-worker-fixture",
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: { not_found_handling: "none", binding: "ASSETS" },
      }),
    );
    // Force the metadata response through the middleware header/status rebuild
    // that previously discarded the internal fully-buffered marker.
    await fs.writeFile(
      path.join(root, "middleware.ts"),
      `import { NextResponse } from "next/server";
export function middleware() {
  const response = NextResponse.next();
  response.headers.set("x-metadata-middleware", "applied");
  return response;
}
export const config = { matcher: ["/robots.txt"] };
`,
    );
    const cloudflarePluginPath = path.join(
      root,
      "node_modules/@cloudflare/vite-plugin/dist/index.mjs",
    );
    const { cloudflare } = (await import(pathToFileURL(cloudflarePluginPath).href)) as {
      cloudflare: CloudflarePluginFactory;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();

    const wranglerPath = path.join(root, "node_modules/wrangler/wrangler-dist/cli.js");
    const wrangler = (await import(pathToFileURL(wranglerPath).href)) as {
      unstable_startWorker(options: {
        config: string;
        dev: {
          remote: false;
          persist: false;
          logLevel: "none";
          watch: false;
          server: { port: 0 };
        };
      }): Promise<{ url: Promise<URL>; dispose(): Promise<void> }>;
    };
    worker = await wrangler.unstable_startWorker({
      config: path.join(root, "dist/server/wrangler.json"),
      dev: {
        remote: false,
        persist: false,
        logLevel: "none",
        watch: false,
        server: { port: 0 },
      },
    });
    await worker.url;
    baseUrl = (await worker.url).origin;
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves Content-Length on a metadata route file convention response (robots.txt)", async () => {
    // Accept-Encoding: identity opts out of compression, which would drop
    // Content-Length for an unrelated reason — Node's fetch() otherwise
    // negotiates gzip/br automatically.
    const res = await fetch(`${baseUrl}/robots.txt`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("x-metadata-middleware")).toBe("applied");

    const bodyText = await res.text();
    expect(bodyText).toContain("Disallow: /private/");

    const expectedLength = new TextEncoder().encode(bodyText).byteLength;
    const contentLength = res.headers.get("content-length");
    expect(contentLength).not.toBeNull();
    expect(Number(contentLength)).toBe(expectedLength);
  });

  it("preserves Content-Length on a metadata sitemap.xml response", async () => {
    const res = await fetch(`${baseUrl}/sitemap.xml`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();

    const bodyText = await res.text();
    expect(bodyText).toContain("<urlset");

    const expectedLength = new TextEncoder().encode(bodyText).byteLength;
    const contentLength = res.headers.get("content-length");
    expect(contentLength).not.toBeNull();
    expect(Number(contentLength)).toBe(expectedLength);
  });

  it("leaves a hand-written Route Handler response chunked (arbitrary bodies keep close tracking)", async () => {
    const res = await fetch(`${baseUrl}/api/get-only`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ method: "GET" }));
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("still defers and runs after() callbacks for a route that registers one", async () => {
    const before = (await (await fetch(`${baseUrl}/api/after-test`)).json()) as {
      counter: number;
    };

    const postRes = await fetch(`${baseUrl}/api/after-test`, { method: "POST" });
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ success: true });

    // The fixture's after() callback does ~2s of simulated background work
    // before incrementing the counter, so poll for it rather than sleeping a
    // fixed duration and checking once.
    await waitForCondition(
      async () => {
        const after = (await (await fetch(`${baseUrl}/api/after-test`)).json()) as {
          counter: number;
        };
        return after.counter === before.counter + 1;
      },
      { timeoutMs: 5000 },
    );
  });

  it("still runs after() registered from within a Route Handler's own still-producing stream, after the handler itself has already returned", async () => {
    await fetch(`${baseUrl}/api/late-after-stream?reset=1`);
    const before = (await (await fetch(`${baseUrl}/api/late-after-stream?check=1`)).json()) as {
      ran: boolean;
    };
    expect(before.ran).toBe(false);

    const streamRes = await fetch(`${baseUrl}/api/late-after-stream`);
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-length")).toBeNull();
    expect(await streamRes.text()).toBe("hello-stream");

    await waitForCondition(
      async () => {
        const after = (await (await fetch(`${baseUrl}/api/late-after-stream?check=1`)).json()) as {
          ran: boolean;
        };
        return after.ran === true;
      },
      { timeoutMs: 5000 },
    );
  });

  it("keeps a streaming HTML response chunked", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("transfer-encoding")).toBe("chunked");
  });
});
