/**
 * Packages built on Node-API addons cannot run on workerd. vinext resolves
 * them to an empty module for Cloudflare, so importing one neither fails the
 * build (napi-rs packages statically require their `.node` binary) nor takes
 * down the routes around it (sharp throws from its module body on workerd).
 * Nothing has to be written into the app: `vinext init` used to emit
 * `resolve.alias` entries pointing at an `empty-stub.js` it never created
 * (https://github.com/cloudflare/vinext/issues/4196).
 *
 * The packages here stand in for the real ones: same names, same failure.
 * satori is plain JavaScript and WebAssembly, so it must keep resolving.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const CF_APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const CLOUDFLARE_NODE_MODULES = path.join(CF_APP_FIXTURE_DIR, "node_modules");

type CloudflarePluginFactory = (options?: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

type StartedWorker = {
  url: Promise<URL>;
  dispose(): Promise<void>;
};

type Wrangler = {
  unstable_startWorker(options: {
    config: string;
    dev: {
      remote: false;
      persist: false;
      logLevel: "none";
      watch: false;
      server: { port: 0 };
    };
  }): Promise<StartedWorker>;
};

const FILES: Record<string, string | Uint8Array> = {
  // Like every napi-rs package: a static require of the platform binary.
  "lib/node_modules/@resvg/resvg-js/package.json": JSON.stringify({
    name: "@resvg/resvg-js",
    main: "index.js",
  }),
  "lib/node_modules/@resvg/resvg-js/index.js": 'module.exports = require("./resvgjs.node");\n',
  "lib/node_modules/@resvg/resvg-js/resvgjs.node": new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0xff]),
  "lib/node_modules/sharp/package.json": JSON.stringify({ name: "sharp", main: "index.js" }),
  "lib/node_modules/sharp/index.js": 'throw new Error("sharp: Could not load the native addon");\n',
  "lib/node_modules/satori/package.json": JSON.stringify({
    name: "satori",
    type: "module",
    exports: { ".": "./index.js", "./wasm": "./wasm.js" },
  }),
  "lib/node_modules/satori/index.js": 'export default function satori() { return "satori"; }\n',
  "lib/node_modules/satori/wasm.js": 'export const init = () => "satori-wasm";\n',
  // A dependency that pulls native modules in, as image libraries do with sharp.
  "lib/node_modules/wrapper/package.json": JSON.stringify({ name: "wrapper", main: "index.js" }),
  "lib/node_modules/wrapper/index.js": `const sharp = require("sharp");
const { Resvg } = require("@resvg/resvg-js");
const lightningcss = require("lightningcss");
module.exports = [typeof Resvg, typeof sharp, lightningcss].join(":");
`,
  // An app's own replacement for a native module wins over the stub.
  "lib/lightningcss-shim.cjs": 'module.exports = "lightningcss-shim";\n',
  "lib/native.ts": `import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import satori from "satori";
import { init } from "satori/wasm";
import lightningcss from "lightningcss";
import wrapper from "wrapper";

export const label = [typeof Resvg, typeof sharp, satori(), init(), lightningcss, wrapper].join(":");
`,
  "lib/client.tsx": `"use client";
import sharp from "sharp";

export function ClientNative() {
  return <p id="client-native">{typeof sharp}</p>;
}
`,
  "app/native-stubs/page.tsx": `import { label } from "../../lib/native";
import { ClientNative } from "../../lib/client";

export default function Page() {
  return <>
    <p id="native">{label}</p>
    <ClientNative />
  </>;
}
`,
};

const EXPECTED = [
  '<p id="native">undefined:object:satori:satori-wasm:lightningcss-shim:undefined:object:lightningcss-shim</p>',
  '<p id="client-native">object</p>',
];

async function createFixture(prefix: string): Promise<string> {
  const root = await createIsolatedFixture(
    CF_APP_FIXTURE_DIR,
    prefix,
    undefined,
    CLOUDFLARE_NODE_MODULES,
  );
  for (const [file, contents] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  return root;
}

async function loadCloudflarePlugin(root: string): Promise<CloudflarePluginFactory> {
  const pluginPath = path.join(root, "node_modules/@cloudflare/vite-plugin/dist/index.mjs");
  const { cloudflare } = (await import(pathToFileURL(pluginPath).href)) as {
    cloudflare: CloudflarePluginFactory;
  };
  return cloudflare;
}

describe("native Node modules on Cloudflare", () => {
  describe("production build", () => {
    let root = "";
    let worker: StartedWorker | undefined;

    beforeAll(async () => {
      root = await createFixture("vinext-native-module-stubs-build-");
      const cloudflare = await loadCloudflarePlugin(root);
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [
          vinext({ appDir: root }),
          cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
        ],
        resolve: { alias: { lightningcss: path.join(root, "lib/lightningcss-shim.cjs") } },
        logLevel: "silent",
      });
      await builder.buildApp();

      const wranglerPath = path.join(root, "node_modules/wrangler/wrangler-dist/cli.js");
      const wrangler = (await import(pathToFileURL(wranglerPath).href)) as Wrangler;
      worker = await wrangler.unstable_startWorker({
        config: path.join(root, "dist/server/wrangler.json"),
        dev: { remote: false, persist: false, logLevel: "none", watch: false, server: { port: 0 } },
      });
    }, 180_000);

    afterAll(async () => {
      await worker?.dispose();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("renders a page that imports native modules", async () => {
      const origin = (await worker!.url).origin;
      const response = await fetch(`${origin}/native-stubs`);
      expect(response.status).toBe(200);
      const html = await response.text();
      for (const expected of EXPECTED) expect(html).toContain(expected);
    }, 30_000);
  });

  describe("dev server", () => {
    let root = "";
    let server: ViteDevServer | undefined;

    beforeAll(async () => {
      root = await createFixture("vinext-native-module-stubs-dev-");
      const cloudflare = await loadCloudflarePlugin(root);
      server = await createServer({
        root,
        configFile: false,
        plugins: [
          vinext({ appDir: root }),
          cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
        ],
        resolve: { alias: { lightningcss: path.join(root, "lib/lightningcss-shim.cjs") } },
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "silent",
      });
      await server.listen();
    }, 120_000);

    afterAll(async () => {
      await server?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("renders a page that imports native modules", async () => {
      const address = server!.httpServer?.address();
      if (!address || typeof address !== "object") throw new Error("dev server did not listen");
      const origin = `http://127.0.0.1:${address.port}`;
      // The first request discovers vinext's own runtime dependencies, and the
      // optimizer reloads the Worker's module graph while it renders.
      await (await fetch(origin)).text();
      const response = await fetch(`${origin}/native-stubs`);
      expect(response.status).toBe(200);
      const html = await response.text();
      for (const expected of EXPECTED) expect(html).toContain(expected);
    }, 60_000);
  });
});
