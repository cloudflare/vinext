import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, createServer } from "vite";

const fixture = path.resolve(process.cwd(), "tests/fixtures/font-google-pages");

export async function createPagesFontFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-google-font-"));
  await fs.cp(fixture, root, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules`),
  });
  await fs.symlink(
    path.resolve(process.cwd(), "node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  return root;
}

function mockGoogleFonts(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "fonts.googleapis.com") {
      const family = url.searchParams.get("family")!.split(":")[0];
      const file = family.toLowerCase().replaceAll(" ", "-");
      const css = `/* latin */
@font-face {
  font-family: '${family}';
  src: url(https://fonts.gstatic.com/${file}.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`;
      return new Response(css, { headers: { "content-type": "text/css" } });
    }
    if (url.hostname === "fonts.gstatic.com") {
      return new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]), {
        headers: { "content-type": "font/woff2" },
      });
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

type FixtureServer = { url: string; close(): Promise<void> };

export async function startPagesFontProduction(root: string): Promise<FixtureServer> {
  const { default: vinext } = await import("../packages/vinext/src/index.js");
  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const outDir = path.join(root, "dist");
  // Pin a deployment ID to exercise the immutable font URLs. The mocked
  // stylesheet still points at the Google CDN so Vite rewrites real URLs.
  const plugins = () => [vinext({ nextConfig: () => ({ deploymentId: "dpl-pages-font-prod" }) })];
  const restoreFetch = mockGoogleFonts();
  try {
    await build({
      root,
      configFile: false,
      plugins: plugins(),
      logLevel: "silent",
      build: {
        assetsInlineLimit: 0,
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
    });
    await build({
      root,
      configFile: false,
      plugins: plugins(),
      logLevel: "silent",
      build: {
        assetsInlineLimit: 0,
        outDir: path.join(outDir, "client"),
        manifest: true,
        ssrManifest: true,
        rolldownOptions: { input: "virtual:vinext-client-entry" },
      },
    });
  } finally {
    restoreFetch();
  }

  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir,
    noCompression: true,
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No Pages production address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export async function startPagesFontDevelopment(root: string): Promise<FixtureServer> {
  const restoreFetch = mockGoogleFonts();
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const { default: vinext } = await import("../packages/vinext/src/index.js");
    server = await createServer({
      root,
      configFile: false,
      // Keep dev preloads distinct from production URLs in the same process.
      plugins: [vinext({ nextConfig: () => ({ assetPrefix: "/font-dev" }) })],
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    // Transform with the fixture's CDN mock before a Pages request patches fetch.
    await server.environments.ssr.transformRequest("/pages/_app.tsx");
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error("No Pages development address");
    const devServer = server;
    return {
      url,
      close: async () => {
        restoreFetch();
        await devServer.close();
      },
    };
  } catch (error) {
    restoreFetch();
    await server?.close();
    throw error;
  }
}
