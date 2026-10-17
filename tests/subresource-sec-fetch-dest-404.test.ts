/**
 * App Router: a GET/HEAD request for an unmatched path whose `Sec-Fetch-Dest`
 * is a non-HTML subresource destination (image, script, style, font, ...)
 * gets a plain-text 404, not the rendered `not-found` page.
 *
 * Next.js short-circuits these before invoking the not-found route (saves the
 * cost of rendering a full HTML document for what is almost certainly a
 * browser auto-requesting a stale/missing subresource — e.g. a PWA manifest
 * icon after a deploy removed it).
 *
 * Source: `packages/next/src/server/base-server.ts` (the `is404Page` branch)
 * + `packages/next/src/server/lib/is-non-html-sec-fetch-dest.ts`.
 *
 * Ported from Next.js:
 *   test/e2e/app-dir/not-found-non-document-dynamic/not-found-non-document-dynamic.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found-non-document-dynamic/not-found-non-document-dynamic.test.ts
 */

import { describe, it, expect, afterAll } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const NOT_FOUND_MARKER = "__not-found-component-rendered__";

async function buildFixture(registerCleanup: (cleanup: () => void) => void): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-subresource-404-"));
  registerCleanup(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.symlinkSync(ROOT_NODE_MODULES, path.join(root, "node_modules"), "junction");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(root, "next.config.mjs"), "export default {};\n");
  fs.writeFileSync(
    path.join(root, "app/layout.tsx"),
    `export default function Root({ children }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  fs.writeFileSync(
    path.join(root, "app/page.tsx"),
    `export default function Page() {
  return <p>hello world</p>;
}
`,
  );
  fs.writeFileSync(
    path.join(root, "app/not-found.tsx"),
    `export default function NotFound() {
  return <p>${NOT_FOUND_MARKER} custom not found page</p>;
}
`,
  );

  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();
  return root;
}

describe("App Router: Sec-Fetch-Dest subresource 404", () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const c of cleanups) c();
  });
  const register = (cleanup: () => void) => cleanups.push(cleanup);

  it("returns a plain text 404 for an unmatched path requested as a subresource", async () => {
    const root = await buildFixture(register);
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/web-app-manifest-192x192.png`, {
        headers: {
          accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8",
          "sec-fetch-dest": "image",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-site": "same-origin",
        },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(res.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      const body = await res.text();
      expect(body).toBe("Not Found");
      expect(body).not.toContain(NOT_FOUND_MARKER);

      // Sanity check: a document request to the same kind of unmatched path
      // still renders the custom not-found page.
      const docRes = await fetch(`${baseUrl}/does-not-exist`, {
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
        },
      });
      expect(docRes.status).toBe(404);
      expect(docRes.headers.get("content-type")).toMatch(/^text\/html/);
      expect(await docRes.text()).toContain(NOT_FOUND_MARKER);
    } finally {
      server.close();
    }
  }, 180_000);

  it("still renders the not-found page for a fetch (empty dest) request", async () => {
    const root = await buildFixture(register);
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/does-not-exist`, {
        headers: {
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(await res.text()).toContain(NOT_FOUND_MARKER);
    } finally {
      server.close();
    }
  }, 180_000);
});
