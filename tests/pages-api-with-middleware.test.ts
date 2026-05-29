import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { build } from "vite-plus";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import vinext from "../packages/vinext/src/index.js";

/**
 * Regression coverage for issue #1477:
 * "Pages Router: API route returns 500 when middleware is present".
 *
 * Inspired by Next.js: test/e2e/proxy-request-with-middleware/test/index.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/proxy-request-with-middleware/test/index.test.ts
 *
 * When a project defines a middleware whose matcher covers `/api/*` paths, the
 * API handler must still dispatch normally — the middleware pipeline must not
 * short-circuit, swallow, or replace the API response. Every assertion below
 * (GET, POST, query-string, custom request headers, the bare `/api` index
 * handler, and middleware-injected request headers) drives a different code
 * path through the prod-server's middleware → API handoff in
 * `packages/vinext/src/server/prod-server.ts`.
 *
 * The repo's `pages-basic` fixture deliberately excludes `/api` from its
 * middleware matcher (`/((?!api|_next|favicon\.ico|...).*)`), so the existing
 * end-to-end tests never exercise this exact pairing. This file fills that gap.
 */

const PAGES_APP_COMPONENT = `export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
`;

function unwrapStartedProdServer(
  result: import("node:http").Server | { server: import("node:http").Server },
): import("node:http").Server {
  return "server" in result ? result.server : result;
}

async function buildFixture(rootDir: string, outDir: string): Promise<void> {
  await build({
    root: rootDir,
    configFile: false,
    plugins: [vinext({ disableAppRouter: true })],
    logLevel: "silent",
    build: {
      outDir: path.join(outDir, "server"),
      ssr: "virtual:vinext-server-entry",
      rollupOptions: { output: { entryFileNames: "entry.js" } },
    },
  });

  await build({
    root: rootDir,
    configFile: false,
    plugins: [vinext({ disableAppRouter: true })],
    logLevel: "silent",
    build: {
      outDir: path.join(outDir, "client"),
      manifest: true,
      ssrManifest: true,
      rollupOptions: { input: "virtual:vinext-client-entry" },
    },
  });
}

describe("Pages Router API route with no-op middleware (#1477)", () => {
  let tmpRoot: string;
  let fixtureOutDir: string;
  let prodServer: import("node:http").Server | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-pages-api-mw-"));
    fixtureOutDir = path.join(tmpRoot, "dist");

    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpRoot, "node_modules"), "junction");

    await fsp.mkdir(path.join(tmpRoot, "pages", "api"), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ type: "module" }));
    await fsp.writeFile(path.join(tmpRoot, "pages", "_app.tsx"), PAGES_APP_COMPONENT);
    await fsp.writeFile(
      path.join(tmpRoot, "pages", "index.tsx"),
      `export default function Home() { return <div>Home</div>; }\n`,
    );
    // Minimal API route that echoes back method + a marker. Returning JSON
    // confirms the handler actually executed instead of being short-circuited
    // by a 500 from the middleware pipeline.
    await fsp.writeFile(
      path.join(tmpRoot, "pages", "api", "hello.ts"),
      `import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ method: req.method, ok: true });
}
`,
    );
    // `/api` root handler — mirrors the Next.js fixture's `pages/api/index.js`.
    // Some failure modes in this area are specific to the bare /api path
    // (matched as `pages/api/index.{ts,js}`).
    await fsp.writeFile(
      path.join(tmpRoot, "pages", "api", "index.ts"),
      `import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ method: req.method, headers: req.headers });
}
`,
    );
    // Exercises the post-middleware request-header propagation path: middleware
    // sets a request header via NextResponse.next({ request: { headers } }) and
    // the API handler must observe it.
    await fsp.writeFile(
      path.join(tmpRoot, "pages", "api", "with-injected-headers.ts"),
      `import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ injected: req.headers["x-from-middleware"] ?? null });
}
`,
    );
    // No-op middleware whose matcher INCLUDES /api routes. Mirrors the
    // Next.js fixture (test/e2e/proxy-request-with-middleware/app/middleware.js)
    // which has no matcher at all and so runs for every request, including
    // /api routes.
    await fsp.writeFile(
      path.join(tmpRoot, "middleware.ts"),
      `import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const url = new URL(request.url);
  // Inject a request header for one specific endpoint to exercise the
  // post-middleware request-header propagation path through the API
  // handler — this is the same code path that wraps every API call when
  // middleware runs.
  if (url.pathname === "/api/with-injected-headers") {
    const headers = new Headers(request.headers);
    headers.set("x-from-middleware", "yes");
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
}
`,
    );

    await buildFixture(tmpRoot, fixtureOutDir);

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    prodServer = unwrapStartedProdServer(
      await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir: fixtureOutDir,
      }),
    );
    const addr = prodServer.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 60000);

  afterAll(async () => {
    if (prodServer) {
      await new Promise<void>((resolve) => prodServer!.close(() => resolve()));
    }
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /api/hello returns 200 when middleware runs", async () => {
    const res = await fetch(`${baseUrl}/api/hello`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ method: "GET", ok: true });
  });

  it("POST /api/hello returns 200 when middleware runs", async () => {
    const res = await fetch(`${baseUrl}/api/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ method: "POST", ok: true });
  });

  it("GET /api/hello?q=1 returns 200 when middleware runs", async () => {
    const res = await fetch(`${baseUrl}/api/hello?q=1`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ method: "GET", ok: true });
  });

  it("POST /api/hello with custom headers returns 200 when middleware runs", async () => {
    const res = await fetch(`${baseUrl}/api/hello`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-custom-header": "some value",
      },
      body: JSON.stringify({ key: "value" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ method: "POST", ok: true });
  });

  // Mirrors the Next.js fixture: tests against `/api` (root index handler)
  // rather than a deeper path. The Next.js test that triggered this issue
  // (test/e2e/proxy-request-with-middleware) only ever exercises /api, so
  // covering the bare /api path is part of the regression contract.
  it("GET /api returns 200 when middleware runs", async () => {
    const res = await fetch(`${baseUrl}/api`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { method: string };
    expect(data.method).toBe("GET");
  });

  it("GET /api/with-injected-headers sees middleware-set request headers", async () => {
    const res = await fetch(`${baseUrl}/api/with-injected-headers`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ injected: "yes" });
  });

  it("POST /api with body and custom headers returns 200 when middleware runs", async () => {
    const res = await fetch(`${baseUrl}/api`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-custom-header": "some value",
      },
      body: JSON.stringify({ key: "value" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      method: string;
      headers: Record<string, string>;
    };
    expect(data.method).toBe("POST");
    expect(data.headers["x-custom-header"]).toBe("some value");
  });
});
