import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { it } from "vite-plus/test";
import { createNextIntlFixture } from "./next-intl-fixture.js";

// Cold-start coverage for https://github.com/cloudflare/vinext/issues/3510
// Reuse the real next-intl app, including middleware, server navigation, and
// client translations. No readiness request may warm its dependency graph.
it.each(
  [
    { convention: "middleware", layout: "hoisted" },
    { convention: "proxy", layout: "hoisted" },
    { convention: "middleware", layout: "isolated" },
  ].filter(({ layout }) => !process.env.VINEXT_NEXT_INTL_NODE_MODULES || layout === "hoisted"),
)(
  "renders next-intl on the first Cloudflare request with $convention and $layout dependencies",
  async ({ convention, layout }) => {
    const root = await createNextIntlFixture({ convention, layout });
    try {
      // plugin-rsc's framework dependency crawl uses process.cwd(), so run in
      // the app directory, like `vite dev` (and the other ecosystem tests).
      await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import assert from "node:assert/strict";
import { createServer } from "vite";
const server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
try {
  await server.listen();
  const baseUrl = server.resolvedUrls.local[0];
  const response = await fetch(new URL("/en", baseUrl));
  const html = await response.text();
  assert.equal(response.status, 200, html);
  assert.ok(html.includes('data-testid="client-greeting">Hello World'), html);
  assert.ok(html.includes('href="/de"'), html);
  for (const name of ["rsc", "ssr"]) {
    assert.equal(server.config.environments[name].optimizeDeps.noDiscovery, false);
    assert.ok(server.config.environments[name].optimizeDeps.include.includes("react"));
  }
  const translated = await fetch(new URL("/de", baseUrl));
  assert.equal(translated.status, 200);
  assert.ok((await translated.text()).includes('data-testid="client-greeting">Hallo Welt'));
} finally {
  await server.close();
}
`,
        ],
        { cwd: root, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  70_000,
);
