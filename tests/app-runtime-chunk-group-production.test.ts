import fs from "node:fs";
import path from "node:path";
import { createBuilder, type Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-runtime-chunk-group");

type ManifestChunk = { file: string; imports?: string[] };

/** The `src` of each `<script type="module" async>` in a document's `<head>`. */
function headModuleScripts(html: string): string[] {
  const head = html.slice(0, html.indexOf("<body"));
  return (head.match(/<script\b[^>]*>/g) ?? [])
    .filter((tag) => tag.includes('type="module"') && /\basync\b/.test(tag))
    .map((tag) => tag.match(/\bsrc="([^"]+)"/)![1]!);
}

// A client chunk group that captures vinext's own runtime moves
// `server/app-browser-entry`, whose top level starts hydration, out of the
// entry chunk and into a chunk the entry imports (issue #4505).
describe("App Router production build with a chunk group that captures the browser runtime", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: import("node:http").Server | undefined;
  let runtimeChunk = "";

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-runtime-chunk-group-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    const findRuntimeChunk: Plugin = {
      name: "test:find-app-browser-runtime-chunk",
      applyToEnvironment: (environment) => environment.name === "client",
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (
            chunk.type === "chunk" &&
            chunk.moduleIds.some((id) =>
              id.split(path.sep).join("/").endsWith("/server/app-browser-entry.ts"),
            )
          ) {
            runtimeChunk = chunk.fileName;
          }
        }
      },
    };
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir }), findRuntimeChunk],
      logLevel: "silent",
      environments: {
        client: {
          build: {
            rolldownOptions: {
              output: {
                codeSplitting: {
                  // A common vendor group. The in-repo vinext runtime resolves
                  // to packages/vinext/src rather than node_modules.
                  groups: [
                    { name: "vendor", test: /[\\/](node_modules|packages[\\/]vinext)[\\/]/ },
                  ],
                },
              },
            },
          },
        },
      },
    });
    await builder.buildApp();

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      outDir: path.join(fixtureDir, "dist"),
      noCompression: true,
    }));
    const address = server.address();
    expect(address && typeof address === "object").toBeTruthy();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("only evaluates the browser runtime from the bootstrap script at the end of the shell", async () => {
    const clientDir = path.join(fixtureDir, "dist", "client");
    const buildManifest: Record<string, ManifestChunk> = JSON.parse(
      fs.readFileSync(path.join(clientDir, ".vite", "manifest.json"), "utf8"),
    );
    const keyByFile = new Map(
      Object.entries(buildManifest).map(([key, chunk]) => [chunk.file, key]),
    );
    const reachesRuntime = (file: string, seen = new Set<string>()): boolean => {
      if (file === runtimeChunk) return true;
      if (seen.has(file)) return false;
      seen.add(file);
      const chunk = buildManifest[keyByFile.get(file) ?? ""];
      return (chunk?.imports ?? []).some((key) => reachesRuntime(buildManifest[key]!.file, seen));
    };

    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="counter"');

    // The group moved the runtime out of the entry chunk.
    expect(runtimeChunk).not.toBe("");
    const { appBrowserEntry } = JSON.parse(
      fs.readFileSync(path.join(clientDir, "vinext-client-entry-manifest.json"), "utf8"),
    );
    expect(appBrowserEntry).toBeTruthy();
    expect(appBrowserEntry).not.toBe(runtimeChunk);

    // An async module script in <head> evaluates as soon as it loads, which on
    // a reload can be before <body> has streamed.
    const headScripts = headModuleScripts(html);
    expect(headScripts.length).toBeGreaterThan(0);
    for (const src of headScripts) {
      expect(reachesRuntime(src.slice(1)), `${src} evaluates the browser runtime`).toBe(false);
    }
    // It still fetches early.
    expect(html).toMatch(
      new RegExp(`<link\\b[^>]*\\brel="modulepreload"[^>]*\\bhref="/${runtimeChunk}"`),
    );

    // Cloudflare builds read the same lists from the server sidecar.
    const sidecar = fs.readFileSync(
      path.join(fixtureDir, "dist", "server", "vinext-client-assets.js"),
      "utf8",
    );
    const assets = JSON.parse(sidecar.replace(/^export default /, "").replace(/;\n$/, ""));
    expect(assets.appBootstrapPreloadModules).toContain(`/${runtimeChunk}`);
    expect(assets.appBootstrapPreinitModules ?? []).not.toContain(`/${runtimeChunk}`);
  });
});
