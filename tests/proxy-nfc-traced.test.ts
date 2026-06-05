/**
 * proxy-nfc-traced regression test
 *
 * Ported from Next.js: test/e2e/app-dir/proxy-nfc-traced/proxy-nfc-traced.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/proxy-nfc-traced/proxy-nfc-traced.test.ts
 *
 * Issue: #1546
 *
 * The Next.js fixture's `proxy.ts` has two notable properties:
 *
 *   1. The default-exported proxy function redirects `/home` → `/`.
 *   2. The fall-through code path references `__filename`, a CommonJS global
 *      that does not exist in ESM. In Next.js the bundler injects a stub for
 *      `__filename`, so the middleware merely logs a string.
 *
 * vinext bundles user middleware as ESM. Before this fix, an unguarded
 * reference to `__filename` would throw `ReferenceError: __filename is not
 * defined` on every request that did NOT match the redirect branch — including
 * the `/` request after the `/home` redirect was followed by the client. Fetch
 * then surfaced an empty 500 body to the test, matching the deploy-suite
 * symptom `Expected: "hello world" / Received: ""`.
 *
 * The fix shims `__filename` and `__dirname` for the user proxy/middleware
 * module the same way Next.js's bundler does so the user code can reference
 * them harmlessly.
 *
 * Note: vitest itself defines `__filename` on the module scope, which masks
 * the production-runtime failure (the dist bundle is loaded via `node`, where
 * ESM modules genuinely have no `__filename`). The structural assertion on
 * the bundled output below is the actual regression guard — the HTTP test
 * exercises the happy path end-to-end.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";

/**
 * Build a minimal fixture in a tmp dir that mirrors the Next.js
 * proxy-nfc-traced fixture layout exactly:
 *   /app/layout.tsx
 *   /app/page.tsx      → renders <p>hello world</p>
 *   /proxy.ts          → default-exports a function that redirects /home → /
 *                        and references `__filename`
 *
 * Uses a workspace node_modules symlink so vinext, react, etc. resolve.
 */
function buildMinimalProxyFixture(prefix: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appDir = path.join(tmpDir, "app");
  fs.mkdirSync(appDir, { recursive: true });

  fs.writeFileSync(
    path.join(appDir, "layout.tsx"),
    `import { ReactNode } from 'react'
export default function Root({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  )
}
`,
  );

  fs.writeFileSync(
    path.join(appDir, "page.tsx"),
    `export default function Page() {
  return <p>hello world</p>
}
`,
  );

  fs.writeFileSync(
    path.join(tmpDir, "proxy.ts"),
    `import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export default function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/home') {
    return NextResponse.redirect(new URL('/', request.url))
  }

  // \`__filename\` included in the bundle makes the NFT to trace it.
  // This will result creating "proxy.js" to be traced into the NFT file.
  // However, as Next.js renames "proxy.js" to "middleware.js" during build,
  // the files in NFT will differ from the actual outputs, which will fail for
  // the providers like Vercel that checks for the files in NFT.
  console.log(__filename)
  // \`__dirname\` is also commonly referenced by middleware that reads files
  // relative to its own location — the shim must cover it too. Reference it
  // so Rolldown does not tree-shake the binding out of the bundle.
  console.log(__dirname)

  return NextResponse.next()
}
`,
  );

  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify(
      {
        name: "proxy-nfc-traced-fixture",
        private: true,
        type: "module",
        dependencies: {
          react: "*",
          "react-dom": "*",
          vinext: "*",
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(tmpDir, "next.config.ts"),
    `import type { NextConfig } from "vinext";
const nextConfig: NextConfig = {};
export default nextConfig;
`,
  );

  // Symlink node_modules from workspace root so vinext, react, etc. resolve.
  const workspaceNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  fs.symlinkSync(workspaceNodeModules, path.join(tmpDir, "node_modules"), "junction");

  return tmpDir;
}

describe("proxy-nfc-traced (#1546)", () => {
  let tmpDir: string;
  let outDir: string;
  let bundleSource: string;
  let server: import("node:http").Server | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = buildMinimalProxyFixture("vinext-proxy-nfc-min-");
    outDir = path.join(tmpDir, "dist");
    fs.rmSync(outDir, { recursive: true, force: true });

    const builder = await createBuilder({
      root: tmpDir,
      configFile: false,
      plugins: [vinext({ appDir: tmpDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    // Mirror the deploy suite: prerender after build so the prod server has
    // cached HTML to seed. The HTTP test below uses the seeded cache.
    const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");
    await runPrerender({ root: tmpDir });

    bundleSource = fs.readFileSync(path.join(outDir, "server", "index.js"), "utf-8");

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({ port: 0, outDir, noCompression: false }));
    const addr = server!.address();
    const port = typeof addr === "object" && addr ? addr.port : 4210;
    baseUrl = `http://localhost:${port}`;
  }, 120000);

  afterAll(() => {
    server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Structural regression guards ──────────────────────────────────────────
  //
  // These check the BUNDLED output. They catch the bug even though vitest's
  // own runtime defines `__filename` on the test module's scope, masking the
  // production-Node failure mode.

  it("the bundled proxy module declares its own __filename binding", () => {
    // The build-time plugin in vinext/plugins/middleware-cjs-globals.ts must
    // inject a `__filename` const into the user proxy/middleware source. The
    // generated bundle preserves Rolldown's region marker, so we anchor on
    // that to scope the assertion to the user proxy module specifically.
    const region = extractProxyRegion(bundleSource);
    expect(region).toMatch(/(?:var|const|let)\s+__filename\s*=\s*"/);
  });

  it("the bundled proxy module declares its own __dirname binding", () => {
    const region = extractProxyRegion(bundleSource);
    expect(region).toMatch(/(?:var|const|let)\s+__dirname\s*=\s*"/);
  });

  it("the bundled proxy module still references __filename in proxy()", () => {
    // Sanity check: the original `console.log(__filename)` must still be in
    // the bundle. If a future change accidentally elides the reference, the
    // structural guards above would also be vacuously satisfied.
    const region = extractProxyRegion(bundleSource);
    expect(region).toContain("console.log(__filename)");
  });

  // ── End-to-end checks ─────────────────────────────────────────────────────

  it("renders 'hello world' after the proxy redirects /home to /", async () => {
    // Mirrors `next.render$('/home')` from the Next.js test — default fetch
    // follows the middleware redirect, lands on `/`, and parses the body.
    const res = await fetch(`${baseUrl}/home`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.url.endsWith("/")).toBe(true);
    expect(html).toContain("hello world");
  });

  it("redirects /home → / with status 307", async () => {
    const res = await fetch(`${baseUrl}/home`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/");
  });

  it("renders the page on a non-redirect path that references __filename", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("hello world");
  });
});

/**
 * Extract the bundled region for the user proxy module from
 * `dist/server/index.js`. Rolldown emits `//#region <abs path>/proxy.ts`
 * comments around each input module, so we slice between the matching
 * region/endregion markers.
 */
function extractProxyRegion(bundle: string): string {
  const start = bundle.search(/\/\/#region\s.*\bproxy\.ts$/m);
  if (start === -1) {
    throw new Error("Could not find proxy.ts region marker in bundled output");
  }
  const remainder = bundle.slice(start);
  const endRelative = remainder.indexOf("//#endregion");
  if (endRelative === -1) {
    throw new Error("Could not find matching endregion for proxy.ts");
  }
  return remainder.slice(0, endRelative);
}
