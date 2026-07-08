/**
 * Pages Router: CSS files with non-URL-safe characters in their filename
 * must be served correctly when the browser percent-encodes the path.
 *
 * Regression test for https://github.com/cloudflare/vinext/issues/1472
 *
 * Mirrors Next.js's resource-url-encoding fixture:
 *   - test/e2e/app-dir/resource-url-encoding/pages/pages.tsx imports
 *     `../my@style.css` and expects `rgb(0, 0, 255)` background.
 *   - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/resource-url-encoding/resource-url-encoding.test.ts
 *
 * The browser percent-encodes the `@` (and any other non-URL-safe chars)
 * when fetching the asset, so the server-side static-asset layer must
 * decode the path before looking up the file on disk.
 */

import { describe, it, expect, afterAll } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

function setupFixture(registerCleanup: (cleanup: () => void) => void): {
  tmpDir: string;
  outDir: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-css-url-encoding-"));
  registerCleanup(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.symlinkSync(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(tmpDir, "next.config.mjs"), `export default {};\n`);

  fs.mkdirSync(path.join(tmpDir, "pages"), { recursive: true });
  // Use the same filename as the Next.js fixture: `my@style.css` has an `@`
  // which browsers leave intact in the path component, but the issue's
  // original example used spaces — exercise both shapes via two source CSS
  // files imported from a single page.
  fs.writeFileSync(path.join(tmpDir, "my@style.css"), "body { background: rgb(0, 0, 255); }\n");
  fs.writeFileSync(path.join(tmpDir, "with space.css"), "html { color: rgb(255, 0, 0); }\n");
  fs.writeFileSync(
    path.join(tmpDir, "pages", "index.tsx"),
    `import "../my@style.css";
import "../with space.css";
export default function HomePage() {
  return <p>hello world</p>;
}
`,
  );
  return { tmpDir, outDir: path.join(tmpDir, "dist") };
}

async function buildPagesFixture(tmpDir: string, outDir: string): Promise<void> {
  await build({
    root: tmpDir,
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
    root: tmpDir,
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
}

describe("Pages Router CSS with URL-encoded characters in path (issue #1472)", () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const c of cleanups) c();
  });
  const register = (cleanup: () => void) => cleanups.push(cleanup);

  it("serves CSS files emitted under /_next/static/ regardless of special chars in the filename", async () => {
    const { tmpDir, outDir } = setupFixture(register);
    await buildPagesFixture(tmpDir, outDir);

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Fetch the home page and pull every stylesheet href out of the HTML.
      const homeRes = await fetch(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      const html = await homeRes.text();

      const hrefRe = /<link\s+rel="stylesheet"[^>]*\shref="([^"]+\.css)"/g;
      const hrefs: string[] = [];
      for (const m of html.matchAll(hrefRe)) {
        hrefs.push(m[1]);
      }
      expect(
        hrefs.length,
        `expected at least one stylesheet link in the HTML; got:\n${html}`,
      ).toBeGreaterThan(0);

      // Every stylesheet URL must resolve to a 200 — this is the actual bug
      // surfaced by issue #1472. Pass each href through encodeURI so the
      // browser-style percent-encoding of spaces (or other non-URL-safe
      // chars) is applied before the request hits the server.
      for (const href of hrefs) {
        const encoded = encodeURI(href);
        const res = await fetch(`${baseUrl}${encoded}`);
        expect(res.status, `expected 200 for stylesheet ${encoded}`).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/css/);
        const body = await res.text();
        expect(body.length).toBeGreaterThan(0);
      }
    } finally {
      server.close();
    }
  }, 180_000);
});
