import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { build, createServer, type ViteDevServer } from "vite-plus";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

function assertDocumentAssetProps(html: string, requirePreloads: boolean): void {
  expect(html).not.toContain("data-vinext-head-nonce");
  expect(html).not.toContain("data-vinext-script-nonce");

  const scripts = (html.match(/<script\b[^>]*>/g) ?? []).filter((tag) =>
    tag.includes('nonce="test-nonce"'),
  );
  const preloads = (html.match(/<link\b[^>]*rel="(?:preload|modulepreload)"[^>]*>/g) ?? []).filter(
    (tag) => !tag.includes('id="user-preload"'),
  );
  expect(scripts.length).toBeGreaterThan(0);
  if (requirePreloads) expect(preloads.length).toBeGreaterThan(0);

  for (const tag of [...scripts, ...preloads]) {
    expect(tag).toContain('nonce="test-nonce"');
    expect(tag).toContain('crossorigin="anonymous"');
  }

  expect(html).toMatch(
    /<script[^>]*id="user-script"[^>]*nonce="user-nonce"[^>]*crossorigin="use-credentials"/,
  );
  expect(html).toMatch(
    /<link[^>]*id="user-preload"[^>]*nonce="user-preload-nonce"[^>]*crossorigin="use-credentials"/,
  );
}

// Ported from Next.js: test/e2e/app-document/rendering.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-document/rendering.test.ts
describe("Pages _document script and preload props", () => {
  let root: string;
  let outDir: string;
  let devServer: ViteDevServer;
  let devUrl: string;
  let prodServer: import("node:http").Server;
  let prodUrl: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-document-assets-"));
    outDir = path.join(root, "dist");
    await fsp.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await fsp.mkdir(path.join(root, "pages"));
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await fsp.writeFile(
      path.join(root, "next.config.mjs"),
      'export default { crossOrigin: "anonymous" };\n',
    );
    await fsp.writeFile(
      path.join(root, "pages", "index.tsx"),
      "export default function Page() { return <main>ok</main>; }\n",
    );
    await fsp.writeFile(
      path.join(root, "pages", "_document.tsx"),
      `import { Html, Head, Main, NextScript } from "next/document";
export default function Document() {
  return <Html><Head nonce="test-nonce">
    <script id="user-script" src="/user.js" nonce="user-nonce" crossOrigin="use-credentials" />
    <link id="user-preload" rel="preload" href="/user.js" as="script" nonce="user-preload-nonce" crossOrigin="use-credentials" />
  </Head><body><Main /><NextScript nonce="test-nonce" /></body></Html>;
}
`,
    );

    devServer = await createServer({
      root,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    await devServer.listen();
    const devAddress = devServer.httpServer!.address() as { port: number };
    devUrl = `http://127.0.0.1:${devAddress.port}`;

    for (const buildOptions of [
      {
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
        rollupOptions: { output: { entryFileNames: "entry.js" } },
      },
      {
        outDir: path.join(outDir, "client"),
        manifest: true,
        ssrManifest: true,
        rollupOptions: { input: "virtual:vinext-client-entry" },
      },
    ]) {
      await build({
        root,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        build: buildOptions,
      });
    }

    const started = await startProdServer({ port: 0, host: "127.0.0.1", outDir });
    prodServer = "server" in started ? started.server : started;
    const prodAddress = prodServer.address() as { port: number };
    prodUrl = `http://127.0.0.1:${prodAddress.port}`;
  }, 120000);

  afterAll(async () => {
    await devServer?.close();
    if (prodServer) await new Promise<void>((resolve) => prodServer.close(() => resolve()));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("propagates props in development", async () => {
    const response = await fetch(devUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    assertDocumentAssetProps(html, false);
    const viteScripts = (html.match(/<script\b[^>]*>/g) ?? []).filter(
      (tag) => !tag.includes('id="user-script"') && !tag.includes('nonce="test-nonce"'),
    );
    expect(viteScripts.length).toBeGreaterThan(0);
    for (const tag of viteScripts) {
      expect(tag).not.toContain("nonce=");
      expect(tag).not.toContain("crossorigin=");
    }
  });

  it("propagates props in production", async () => {
    const response = await fetch(prodUrl);
    expect(response.status).toBe(200);
    assertDocumentAssetProps(await response.text(), true);
  });
});
