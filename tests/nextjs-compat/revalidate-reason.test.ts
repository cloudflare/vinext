/**
 * Next.js compat: Pages Router `context.revalidateReason`
 *
 * Source:
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/revalidate-reason/revalidate-reason.test.ts
 *
 * Asserts that getStaticProps receives `context.revalidateReason: "on-demand"`
 * when the page is regenerated via `res.revalidate()` from an API route, and
 * that an unauthenticated `x-prerender-revalidate` header is rejected (it must
 * carry the process revalidate secret, not merely be present — see the security
 * note in `isr-cache.ts`).
 *
 * Tracks vinext#1462.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { build } from "vite-plus";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../../packages/vinext/src/index.js";
import { PRERENDER_REVALIDATE_HEADER } from "../../packages/vinext/src/server/isr-cache.js";
import { startFixtureServer, PAGES_FIXTURE_DIR, type TestServerResult } from "../helpers.js";

let ctx: TestServerResult;

/**
 * Read the `revalidateReason` value rendered by the `/revalidate-reason`
 * fixture. The page renders `<p id="reason">revalidate reason: {reason}</p>`;
 * React inserts a `<!-- -->` text separator before the dynamic value, e.g.
 * `<p id="reason">revalidate reason: <!-- -->on-demand</p>`. The reason itself
 * is always one of a small, fixed set of word tokens, so we extract that token
 * directly instead of stripping arbitrary HTML (which CodeQL — correctly —
 * flags as unreliable sanitization).
 */
function reasonFromHtml(html: string): string {
  const match = html.match(/<p id="reason">revalidate reason:(?:\s|<!--\s*-->)*([a-z-]*)<\/p>/);
  return match ? match[1] : "";
}

describe("Next.js compat: revalidate-reason (Pages Router)", () => {
  beforeAll(async () => {
    ctx = await startFixtureServer(PAGES_FIXTURE_DIR);
  });

  afterAll(async () => {
    await ctx.server.close();
  });

  // NOTE: these run in declaration order and share one server (and therefore
  // one ISR cache). The negative security test runs FIRST, while the cached
  // reason is still "stale", so that a forged header being (incorrectly)
  // honored would be observable as a flip to "on-demand".

  it("rejects a forged x-prerender-revalidate header (not the secret)", async () => {
    // SECURITY: on-demand revalidation must require the process revalidate
    // secret (the vinext analog of Next.js's `previewModeId`). A request that
    // merely *carries* the header with an attacker-chosen value must NOT be
    // treated as on-demand revalidation — otherwise any external client could
    // force synchronous regeneration of any ISR page (cache-stampede/DoS).

    // Prime the cache. In dev there is no build-time prerender, so the initial
    // miss surfaces as "stale".
    const primeRes = await fetch(`${ctx.baseUrl}/revalidate-reason`);
    expect(primeRes.status).toBe(200);
    expect(reasonFromHtml(await primeRes.text())).toBe("stale");

    // Spoofed values: plain presence ("1"), empty, and a random guess. None
    // equals the secret, so each must be IGNORED: the fresh-cache short-circuit
    // still serves the cached "stale" entry and never regenerates as
    // "on-demand".
    for (const value of ["1", "", "not-the-secret"]) {
      const forged = await fetch(`${ctx.baseUrl}/revalidate-reason`, {
        headers: { "x-prerender-revalidate": value },
      });
      expect(forged.status).toBe(200);
      expect(reasonFromHtml(await forged.text())).toBe("stale");
    }
  });

  it('accepts the secret and surfaces revalidateReason: "on-demand"', async () => {
    // Trigger on-demand revalidation via res.revalidate() in the API route,
    // which attaches the real process revalidate secret to the internal
    // request — the only value the receiver authorizes.
    const revalidateRes = await fetch(`${ctx.baseUrl}/api/revalidate-reason`);
    expect(revalidateRes.status).toBe(200);
    expect(await revalidateRes.json()).toEqual({ revalidated: true });

    // The regenerated page must now record the "on-demand" reason.
    const res = await fetch(`${ctx.baseUrl}/revalidate-reason`);
    expect(res.status).toBe(200);
    expect(reasonFromHtml(await res.text())).toBe("on-demand");
  });
});

describe("Next.js compat: revalidate-reason (Pages Router production)", () => {
  const revalidateSecret = "vinext-revalidate-reason-test-secret";
  let previousRevalidateSecret: string | undefined;
  let tmpRoot: string;
  let outDir: string;
  let server: import("node:http").Server;
  let baseUrl: string;

  beforeAll(async () => {
    previousRevalidateSecret = process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
    process.env.__VINEXT_SHARED_REVALIDATE_SECRET = revalidateSecret;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-revalidate-reason-"));
    outDir = path.join(tmpRoot, "dist");

    await fs.symlink(
      path.resolve(import.meta.dirname, "../../node_modules"),
      path.join(tmpRoot, "node_modules"),
      "junction",
    );
    await fs.mkdir(path.join(tmpRoot, "pages", "api"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ type: "module" }));
    await fs.writeFile(
      path.join(tmpRoot, "pages", "index.tsx"),
      `export default function Page({ reason }) {
  return <p id="reason">revalidate reason: {reason}</p>;
}

export async function getStaticProps({ revalidateReason }) {
  return { props: { reason: revalidateReason } };
}
`,
    );
    await fs.writeFile(
      path.join(tmpRoot, "pages", "api", "revalidate.ts"),
      `export default async function handler(_req, res) {
  await res.revalidate("/");
  res.status(200).json({ revalidated: true });
}
`,
    );
    await fs.writeFile(
      path.join(tmpRoot, "pages", "not-found.tsx"),
      `let calls = 0;

export default function Page() { return null; }

export async function getStaticProps() {
  calls += 1;
  if (calls > 1) throw new Error("notFound tombstone was not reused");
  return { notFound: true };
}
`,
    );
    await fs.writeFile(
      path.join(tmpRoot, "pages", "concurrent-failure.tsx"),
      `let onDemandCalls = 0;

export default function Page({ calls }) {
  return <p id="calls">{calls}</p>;
}

export async function getStaticProps({ revalidateReason }) {
  if (revalidateReason === "on-demand") {
    onDemandCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (onDemandCalls === 1) throw new Error("first authoritative generation failed");
  }
  return { props: { calls: onDemandCalls }, revalidate: 60 };
}
`,
    );

    await build({
      root: tmpRoot,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
    });
    await build({
      root: tmpRoot,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "client"),
        manifest: true,
        ssrManifest: true,
        rolldownOptions: { input: "virtual:vinext-client-entry" },
      },
    });

    const { startProdServer } = await import("../../packages/vinext/src/server/prod-server.js");
    const started = await startProdServer({ port: 0, host: "127.0.0.1", outDir });
    server = "server" in started ? started.server : started;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Production server did not listen");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    if (previousRevalidateSecret === undefined) {
      delete process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
    } else {
      process.env.__VINEXT_SHARED_REVALIDATE_SECRET = previousRevalidateSecret;
    }
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('persists revalidateReason: "on-demand" before res.revalidate resolves', async () => {
    const prime = await fetch(baseUrl);
    expect(prime.status).toBe(200);
    expect(reasonFromHtml(await prime.text())).toBe("stale");

    const revalidate = await fetch(`${baseUrl}/api/revalidate`);
    expect(revalidate.status).toBe(200);
    expect(await revalidate.json()).toEqual({ revalidated: true });

    const regenerated = await fetch(baseUrl);
    expect(regenerated.status).toBe(200);
    expect(reasonFromHtml(await regenerated.text())).toBe("on-demand");
  });

  it("emits REVALIDATED for authenticated on-demand success and notFound", async () => {
    const headers = { [PRERENDER_REVALIDATE_HEADER]: revalidateSecret };

    const success = await fetch(baseUrl, { method: "HEAD", headers });
    expect(success.status).toBe(200);
    expect(success.headers.get("x-nextjs-cache")).toBe("REVALIDATED");

    const notFound = await fetch(`${baseUrl}/not-found`, { method: "HEAD", headers });
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("x-nextjs-cache")).toBe("REVALIDATED");

    const cachedNotFound = await fetch(`${baseUrl}/not-found`);
    expect(cachedNotFound.status).toBe(404);
  });

  it("propagates a failed authoritative result to concurrent on-demand callers", async () => {
    const headers = { [PRERENDER_REVALIDATE_HEADER]: revalidateSecret };
    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/concurrent-failure`, { method: "HEAD", headers }),
      fetch(`${baseUrl}/concurrent-failure`, { method: "HEAD", headers }),
    ]);

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(first.headers.get("x-nextjs-cache")).not.toBe("REVALIDATED");
    expect(second.headers.get("x-nextjs-cache")).not.toBe("REVALIDATED");

    const recovered = await fetch(`${baseUrl}/concurrent-failure`, { method: "HEAD", headers });
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("x-nextjs-cache")).toBe("REVALIDATED");
  });
});
