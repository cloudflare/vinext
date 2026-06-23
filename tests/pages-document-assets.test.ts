import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { build, createServer, type ViteDevServer } from "vite-plus";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

function assertDocumentAssetProps(html: string, requireHeadAssets: boolean): void {
  expect(html).not.toContain("data-vinext-head-nonce");
  expect(html).not.toContain("data-vinext-script-nonce");

  const documentScripts = (html.match(/<script\b[^>]*>/gi) ?? []).filter((tag) =>
    tag.includes('nonce="script-nonce"'),
  );
  expect(documentScripts.length).toBeGreaterThan(0);
  for (const tag of documentScripts) {
    expect(tag).toContain('crossorigin="anonymous"');
  }

  const headHtml = html.slice(html.indexOf("<head"), html.indexOf("</head>"));
  const bodyHtml = html.slice(html.indexOf("<body"));
  const generatedHeadAssets = (headHtml.match(/<link\b[^>]*>/gi) ?? []).filter(
    (tag) =>
      !tag.includes('id="user-') &&
      !tag.includes("/@vite/") &&
      (tag.includes('rel="stylesheet"') ||
        tag.includes('rel="preload"') ||
        tag.includes('rel="modulepreload"')),
  );
  if (requireHeadAssets) {
    expect(generatedHeadAssets.length).toBeGreaterThan(0);
    for (const tag of generatedHeadAssets) {
      expect(tag).toContain('nonce="head-nonce"');
      expect(tag).toContain('crossorigin="use-credentials"');
    }

    const generatedRuntimeScripts = (bodyHtml.match(/<script\b[^>]*src=[^>]*>/gi) ?? []).filter(
      (tag) => !tag.includes('id="user-script"'),
    );
    expect(generatedRuntimeScripts.length).toBeGreaterThan(0);
    for (const tag of generatedRuntimeScripts) {
      expect(tag).toContain('nonce="script-nonce"');
      expect(tag).toContain('crossorigin="anonymous"');
      expect(tag).not.toContain('nonce="head-nonce"');
      expect(tag).not.toContain('crossorigin="use-credentials"');
    }
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
      'export default { crossOrigin: "anonymous", experimental: { disableOptimizedLoading: true } };\n',
    );
    await fsp.writeFile(
      path.join(root, "pages", "index.tsx"),
      'import "../style.css";\nexport default function Page() { return <main className="cascade">ok</main>; }\n',
    );
    await fsp.writeFile(path.join(root, "style.css"), ".cascade { color: green }\n");
    await fsp.writeFile(
      path.join(root, "pages", "_document.tsx"),
      `import { Html, Head, Main, NextScript } from "next/document";
export default function Document() {
  return <Html><Head nonce="head-nonce" crossOrigin="use-credentials">
    <style id="custom-document-style">{".cascade { color: red }"}</style>
    <script id="user-script" src="/user.js" nonce="user-nonce" crossOrigin="use-credentials" />
    <link id="user-preload" rel="preload" href="/user.js" as="script" nonce="user-preload-nonce" crossOrigin="use-credentials" />
  </Head><body><Main /><NextScript nonce="script-nonce" /></body></Html>;
}
Document.getInitialProps = async (ctx) => {
  const initialProps = await ctx.defaultGetInitialProps(ctx);
  return {
    ...initialProps,
    styles: <style id="collected-document-style">{".cascade { color: blue }"}</style>,
  };
};
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
    expect(html.indexOf('id="custom-document-style"')).toBeLessThan(
      html.indexOf('id="collected-document-style"'),
    );
    const viteScripts = (html.match(/<script\b[^>]*>/gi) ?? []).filter(
      (tag) => !tag.includes('id="user-script"') && !tag.includes('nonce="script-nonce"'),
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
    const html = await response.text();
    assertDocumentAssetProps(html, true);
    expect(html.indexOf('id="custom-document-style"')).toBeLessThan(
      html.indexOf('id="collected-document-style"'),
    );
  });
});
