import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { build, createServer, type ViteDevServer } from "vite-plus";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

function getStartTags(html: string, tagName: string): string[] {
  const tags: string[] = [];
  const normalizedHtml = html.toLowerCase();
  const marker = `<${tagName.toLowerCase()}`;
  let offset = 0;

  while (offset < html.length) {
    const start = normalizedHtml.indexOf(marker, offset);
    if (start === -1) break;
    const boundary = normalizedHtml[start + marker.length];
    if (boundary !== ">" && !/\s/.test(boundary ?? "")) {
      offset = start + marker.length;
      continue;
    }
    const end = normalizedHtml.indexOf(">", start + marker.length);
    if (end === -1) break;
    tags.push(html.slice(start, end + 1));
    offset = end + 1;
  }

  return tags;
}

function assertDocumentAssetProps(html: string, requirePreloads: boolean): void {
  expect(html).not.toContain("data-vinext-head-nonce");
  expect(html).not.toContain("data-vinext-script-nonce");
  expect(html).not.toContain("data-vinext-document-authored-asset");

  const scripts = getStartTags(html, "script");
  const preloads = getStartTags(html, "link").filter(
    (tag) =>
      (tag.includes('rel="preload"') || tag.includes('rel="modulepreload"')) &&
      !tag.includes('id="user-preload"') &&
      !tag.includes('as="font"'),
  );
  if (requirePreloads) expect(preloads.length).toBeGreaterThan(0);

  for (const tag of preloads) {
    expect(tag).toContain('nonce="head-nonce"');
    expect(tag).toContain('crossorigin="use-credentials"');
  }

  const nextDataScript = scripts.find((tag) => tag.includes('id="__NEXT_DATA__"'));
  expect(nextDataScript).toContain('nonce="next-script-nonce"');
  expect(nextDataScript).toContain('crossorigin="anonymous"');

  const viteClientScript = scripts.find((tag) => tag.includes('src="/@vite/client"'));
  if (viteClientScript) {
    const generatedScripts = scripts.filter((tag) => !tag.includes('id="user-script"'));
    for (const tag of generatedScripts) {
      expect(tag).toContain('nonce="next-script-nonce"');
      expect(tag).toContain('crossorigin="anonymous"');
    }
  } else {
    const frameworkScripts = scripts.filter(
      (tag) =>
        tag.includes("src=") &&
        !tag.includes('id="user-script"') &&
        !tag.includes('id="__NEXT_DATA__"'),
    );
    expect(frameworkScripts.length).toBeGreaterThan(0);
    for (const tag of frameworkScripts) {
      expect(tag).toContain('nonce="head-nonce"');
      expect(tag).toContain('crossorigin="use-credentials"');
    }
  }

  const fontPreload = getStartTags(html, "link").find((tag) => tag.includes('as="font"'));
  expect(fontPreload).toContain('crossorigin="anonymous"');
  expect(fontPreload).not.toContain("nonce=");

  const userScript = getStartTags(html, "script").find((tag) => tag.includes('id="user-script"'));
  expect(userScript).toContain('nonce="user-nonce"');
  expect(userScript).toContain('crossorigin="use-credentials"');
  const userPreload = getStartTags(html, "link").find((tag) => tag.includes('id="user-preload"'));
  expect(userPreload).toContain('nonce="user-preload-nonce"');
  expect(userPreload).toContain('crossorigin="use-credentials"');
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
      `import localFont from "next/font/local";
const font = localFont({ src: "./local.woff2" });
export default function Page() { return <main className={font.className}>ok</main>; }
`,
    );
    await fsp.copyFile(
      path.resolve(import.meta.dirname, "fixtures/font-google-pages/pages/local.woff2"),
      path.join(root, "pages", "local.woff2"),
    );
    await fsp.writeFile(
      path.join(root, "pages", "_document.tsx"),
      `import { Html, Head, Main, NextScript } from "next/document";
export default function Document() {
  return <Html><Head nonce="head-nonce" crossOrigin="use-credentials">
    <script id="user-script" src="/user.js" nonce="user-nonce" crossOrigin="use-credentials" />
    <link id="user-preload" rel="preload" href="/user.js" as="script" nonce="user-preload-nonce" crossOrigin="use-credentials" />
  </Head><body><Main /><NextScript nonce="next-script-nonce" crossOrigin="anonymous" /></body></Html>;
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
    const viteScripts = getStartTags(html, "script").filter((tag) =>
      tag.includes('src="/@vite/client"'),
    );
    expect(viteScripts.length).toBeGreaterThan(0);
    for (const tag of viteScripts) {
      expect(tag).toContain('nonce="next-script-nonce"');
      expect(tag).toContain('crossorigin="anonymous"');
    }
  });

  it("propagates props in production", async () => {
    const response = await fetch(prodUrl);
    expect(response.status).toBe(200);
    assertDocumentAssetProps(await response.text(), true);
  });

  it("applies configured crossOrigin without a custom _document in development", async () => {
    const noDocumentRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "vinext-document-assets-default-"),
    );
    let noDocumentServer: ViteDevServer | undefined;
    try {
      await fsp.symlink(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(noDocumentRoot, "node_modules"),
        "junction",
      );
      await fsp.mkdir(path.join(noDocumentRoot, "pages"));
      await fsp.writeFile(
        path.join(noDocumentRoot, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      await fsp.writeFile(
        path.join(noDocumentRoot, "next.config.mjs"),
        'export default { crossOrigin: "anonymous" };\n',
      );
      await fsp.writeFile(
        path.join(noDocumentRoot, "pages", "index.tsx"),
        "export default function Page() { return <main>ok</main>; }\n",
      );

      noDocumentServer = await createServer({
        root: noDocumentRoot,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "silent",
      });
      await noDocumentServer.listen();
      const address = noDocumentServer.httpServer!.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      const generatedScripts = getStartTags(html, "script").filter(
        (tag) => tag.includes("src=") && !tag.includes('src="/@vite/client"'),
      );
      expect(generatedScripts.length).toBeGreaterThan(0);
      for (const tag of generatedScripts) {
        expect(tag).toContain('crossorigin="anonymous"');
      }
      const viteScripts = getStartTags(html, "script").filter((tag) =>
        tag.includes('src="/@vite/client"'),
      );
      expect(viteScripts.length).toBeGreaterThan(0);
      for (const tag of viteScripts) {
        expect(tag).toContain('crossorigin="anonymous"');
      }
    } finally {
      await noDocumentServer?.close();
      fs.rmSync(noDocumentRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "a custom Document", customDocument: true },
    { label: "the default Document", customDocument: false },
  ])(
    "applies configured crossOrigin to development error-page scripts with $label",
    async ({ customDocument }) => {
      const errorRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-document-error-assets-"));
      let errorServer: ViteDevServer | undefined;
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await fsp.symlink(
          path.resolve(import.meta.dirname, "../node_modules"),
          path.join(errorRoot, "node_modules"),
          "junction",
        );
        await fsp.mkdir(path.join(errorRoot, "pages"));
        await fsp.writeFile(
          path.join(errorRoot, "package.json"),
          JSON.stringify({ type: "module" }),
        );
        await fsp.writeFile(
          path.join(errorRoot, "next.config.mjs"),
          'export default { crossOrigin: "anonymous" };\n',
        );
        await fsp.writeFile(
          path.join(errorRoot, "pages", "index.tsx"),
          'export default function Page() { throw new Error("boom"); }\n',
        );
        await fsp.writeFile(
          path.join(errorRoot, "pages", "_error.tsx"),
          'export default function ErrorPage() { return <><main>error page</main><script id="user-script" src="/user.js" /></>; }\n',
        );
        if (customDocument) {
          await fsp.writeFile(
            path.join(errorRoot, "pages", "_document.tsx"),
            `import { Html, Head, Main, NextScript } from "next/document";
export default function Document() {
  return <Html><Head /><body><Main /><NextScript /></body></Html>;
}
`,
          );
        }

        errorServer = await createServer({
          root: errorRoot,
          configFile: false,
          plugins: [vinext({ disableAppRouter: true })],
          server: { host: "127.0.0.1", port: 0 },
          logLevel: "silent",
        });
        await errorServer.listen();
        const address = errorServer.httpServer!.address() as { port: number };
        const response = await fetch(`http://127.0.0.1:${address.port}`);
        expect(response.status).toBe(500);
        const html = await response.text();
        expect(html).toContain("error page");
        const scripts = getStartTags(html, "script");
        const userScript = scripts.find((tag) => tag.includes('id="user-script"'));
        expect(userScript).not.toContain("crossorigin");
        const generatedScripts = scripts.filter((tag) => tag !== userScript);
        expect(generatedScripts.length).toBeGreaterThan(0);
        for (const tag of generatedScripts) {
          expect(tag).toContain('crossorigin="anonymous"');
        }
      } finally {
        consoleError.mockRestore();
        await errorServer?.close();
        fs.rmSync(errorRoot, { recursive: true, force: true });
      }
    },
  );
});
