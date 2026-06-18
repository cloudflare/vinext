import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8n26QAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_4X3 = fs.readFileSync(path.join(import.meta.dirname, "fixtures/images/test-4x3.png"));
const SVG_2X3 = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"></svg>`;

const tempDirs: string[] = [];
const servers: Server[] = [];
const cloudflarePluginPath = path.resolve(
  import.meta.dirname,
  "fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs",
);
const workerEntryPath = path
  .resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts")
  .replaceAll("\\", "/");

type CloudflarePluginFactory = (options?: {
  viteEnvironment?: { name: string; childEnvironments?: string[] };
}) => import("vite").Plugin;

function writeFixtureFile(root: string, filePath: string, content: string | Buffer): void {
  const absolutePath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

type FixtureOptions = {
  basePath?: string;
  assetPrefix?: string;
  deploymentId?: string;
};

async function createFixture(
  router: "app" | "pages",
  options: FixtureOptions = {},
): Promise<string> {
  const root = await mkdtemp(path.join(import.meta.dirname, `.tmp-${router}-static-image-`));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../packages/vinext/node_modules/ipaddr.js"),
    path.join(root, "node_modules/ipaddr.js"),
    "junction",
  );
  writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ name: `vinext-${router}-static-image`, private: true, type: "module" }),
  );
  writeFixtureFile(
    root,
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }),
  );
  writeFixtureFile(root, "test.png", PNG_1X1);
  writeFixtureFile(root, "client.png", PNG_4X3);
  writeFixtureFile(root, "test.svg", SVG_2X3);
  writeFixtureFile(root, "tiny.png", PNG_1X1);
  if (options.basePath || options.assetPrefix || options.deploymentId) {
    writeFixtureFile(root, "next.config.mjs", `export default ${JSON.stringify(options)};\n`);
  }

  const imageMarkup = `
      <Image id="static-image" alt="static import" src={staticImage} quality={85} />
      <Image id="static-svg" alt="static svg import" src={staticSvg} />
      <img id="ordinary-asset" alt="ordinary asset" src={tinyUrl} />`;

  if (router === "app") {
    writeFixtureFile(
      root,
      "app/layout.tsx",
      `import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
    );
    writeFixtureFile(
      root,
      "app/client-image.tsx",
      `"use client";
import Image from "next/image";
import staticImage from "@/client.png";

export default function ClientImage() {
  return <Image id="client-static-image" alt="client static import" src={staticImage} quality={85} />;
}
`,
    );
    writeFixtureFile(
      root,
      "app/page.tsx",
      `import Image from "next/image";
import staticImage from "../test.png";
import staticSvg from "../test.svg";
import tinyUrl from "../tiny.png?url";
import ClientImage from "./client-image";

export default function Page() {
  return <main>${imageMarkup}<ClientImage /></main>;
}
`,
    );
  } else {
    writeFixtureFile(
      root,
      "pages/index.tsx",
      `import Image from "next/image";
import staticImage from "../test.png";
import staticSvg from "../test.svg";
import tinyUrl from "../tiny.png?url";

export default function Page() {
  return <main>${imageMarkup}</main>;
}
`,
    );
  }

  return root;
}

async function buildFixture(root: string, router: "app" | "pages"): Promise<void> {
  const commonConfig = {
    root,
    configFile: false as const,
    logLevel: "silent" as const,
    build: { assetsInlineLimit: 100_000 },
  };

  if (router === "app") {
    const builder = await createBuilder({
      ...commonConfig,
      plugins: [
        vinext({
          appDir: root,
          rscOutDir: path.join(root, "dist/server"),
          ssrOutDir: path.join(root, "dist/server/ssr"),
          clientOutDir: path.join(root, "dist/client"),
        }),
      ],
    });
    await builder.buildApp();
    return;
  }

  await build({
    ...commonConfig,
    plugins: [vinext()],
    build: {
      ...commonConfig.build,
      outDir: path.join(root, "dist/server"),
      ssr: "virtual:vinext-server-entry",
      rolldownOptions: { output: { entryFileNames: "entry.js" } },
    },
  });
  await build({
    ...commonConfig,
    plugins: [vinext()],
    build: {
      ...commonConfig.build,
      outDir: path.join(root, "dist/client"),
      manifest: true,
      ssrManifest: true,
      rolldownOptions: { input: "virtual:vinext-client-entry" },
    },
  });
}

async function buildCloudflareFixture(root: string): Promise<void> {
  fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  writeFixtureFile(
    root,
    "wrangler.jsonc",
    `{
  "name": "vinext-static-image-cloudflare",
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "./worker/index.ts",
  "assets": { "not_found_handling": "none", "binding": "ASSETS" }
}\n`,
  );
  writeFixtureFile(
    root,
    "worker/index.ts",
    `import handler from ${JSON.stringify(workerEntryPath)};\nexport default handler;\n`,
  );
  const { cloudflare } = (await import(pathToFileURL(cloudflarePluginPath).href)) as {
    cloudflare: CloudflarePluginFactory;
  };
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      vinext({ appDir: root }),
      cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
    ],
  });
  await builder.buildApp();
}

type BuildWatcher = {
  on(event: "event", callback: (event: { code: string; error?: Error }) => void): void;
  off(event: "event", callback: (event: { code: string; error?: Error }) => void): void;
  close(): Promise<void>;
};

function waitForWatchBuild(
  watcher: BuildWatcher,
  isExpectedOutput: () => boolean | Promise<boolean> = () => true,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let checkingOutput = false;
    const cleanup = () => {
      clearTimeout(timeout);
      watcher.off("event", onEvent);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for watch rebuild"));
    }, 20_000);
    const handleEvent = async (event: { code: string; error?: Error }) => {
      if (event.code === "ERROR") {
        cleanup();
        reject(event.error ?? new Error("Watch build failed"));
      } else if (event.code === "END" && !checkingOutput) {
        checkingOutput = true;
        try {
          if (await isExpectedOutput()) {
            cleanup();
            resolve();
          }
        } catch (error) {
          cleanup();
          reject(error);
        } finally {
          checkingOutput = false;
        }
      }
    };
    const onEvent = (event: { code: string; error?: Error }) => {
      void handleEvent(event);
    };
    watcher.on("event", onEvent);
  });
}

async function readBuiltJavaScript(outDir: string): Promise<string> {
  const chunks: string[] = [];
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    const entryPath = path.join(outDir, entry.name);
    if (entry.isDirectory()) chunks.push(await readBuiltJavaScript(entryPath));
    else if (entry.name.endsWith(".js")) chunks.push(await readFile(entryPath, "utf8"));
  }
  return chunks.join("\n");
}

function getAttribute(html: string, id: string, attribute: string): string {
  const tag = html.match(new RegExp(`<img\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
  const value = tag?.match(new RegExp(`\\b${attribute}="([^"]+)"`, "i"))?.[1];
  if (!value) throw new Error(`Missing ${attribute} on image #${id}`);
  return value.replaceAll("&amp;", "&");
}

async function findEmittedAsset(
  root: string,
  assetPrefix: string,
  extension: string,
): Promise<string> {
  const prefixPath = assetPrefix.startsWith("http")
    ? ""
    : assetPrefix.split("/").filter(Boolean).join("/");
  const mediaDir = path.join(root, "dist/client", prefixPath, "_next/static/media");
  const files = await readdir(mediaDir);
  const asset = files.find((file) => new RegExp(`^test\\.[\\w-]{8}\\.${extension}$`).test(file));
  if (!asset)
    throw new Error(`Missing emitted test.${extension} in ${mediaDir}: ${files.join(", ")}`);
  return asset;
}

async function findEmittedImage(root: string, assetPrefix = "", name = "test"): Promise<string> {
  const prefixPath = assetPrefix.startsWith("http")
    ? ""
    : assetPrefix.split("/").filter(Boolean).join("/");
  const mediaDir = path.join(root, "dist/client", prefixPath, "_next/static/media");
  const files = await readdir(mediaDir);
  const image = files.find((file) => new RegExp(`^${name}\\.[\\w-]{8}\\.png$`).test(file));
  if (!image) throw new Error(`Missing emitted ${name}.png in ${mediaDir}: ${files.join(", ")}`);
  return image;
}

async function assertStaticImageProductionParity(
  router: "app" | "pages",
  options: FixtureOptions = {},
): Promise<void> {
  const root = await createFixture(router, options);
  await buildFixture(root, router);
  const effectiveAssetPrefix = options.assetPrefix ?? options.basePath ?? "";
  const emittedImage = await findEmittedImage(root, effectiveAssetPrefix);
  const emittedSvg = await findEmittedAsset(root, effectiveAssetPrefix, "svg");
  const prefixPath = effectiveAssetPrefix.split("/").filter(Boolean).join("/");
  expect(
    await readFile(path.join(root, "dist/client", prefixPath, "_next/static/media", emittedImage)),
  ).toEqual(PNG_1X1);
  const serverJavaScript = await readBuiltJavaScript(path.join(root, "dist/server"));
  expect(serverJavaScript).toContain(`/_next/static/media/${emittedImage}`);
  expect(serverJavaScript).not.toMatch(/\/_next\/static\/test-[\w-]+\.png/);

  const started = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: path.join(root, "dist"),
  });
  servers.push(started.server);
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("Production server did not bind");
  const response = await fetch(`http://127.0.0.1:${address.port}${options.basePath ?? ""}/`);
  const html = await response.text();
  expect(response.status, html).toBe(200);

  const imageIds =
    router === "app"
      ? [
          ["static-image", emittedImage],
          ["client-static-image", await findEmittedImage(root, effectiveAssetPrefix, "client")],
        ]
      : [["static-image", emittedImage]];
  for (const [id, expectedImage] of imageIds) {
    const src = getAttribute(html, id, "src");
    const srcset = getAttribute(html, id, "srcset");
    const managedUrl = `${effectiveAssetPrefix}/_next/static/media/${expectedImage}`;
    const managedSourceUrl = options.deploymentId
      ? `${managedUrl}?dpl=${options.deploymentId}`
      : managedUrl;
    expect(new URL(src, "http://vinext.test").searchParams.get("url")).toBe(managedSourceUrl);
    expect(src).toContain("q=85");
    expect(src).not.toContain("data%3Aimage");
    expect(srcset).toContain(`url=${encodeURIComponent(managedSourceUrl)}`);
    expect(srcset).not.toContain("data%3Aimage");
  }

  expect(getAttribute(html, "ordinary-asset", "src")).toMatch(/^data:image\/png/);
  const managedSvgUrl = `${effectiveAssetPrefix}/_next/static/media/${emittedSvg}${
    options.deploymentId ? `?dpl=${options.deploymentId}` : ""
  }`;
  expect(getAttribute(html, "static-svg", "src")).toBe(managedSvgUrl);
  expect(getAttribute(html, "static-svg", "src")).not.toContain("/_next/image?");
  const assetResponse = await fetch(
    `http://127.0.0.1:${address.port}${effectiveAssetPrefix}/_next/static/media/${emittedImage}`,
  );
  expect(assetResponse.status).toBe(200);
  expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const etag = assetResponse.headers.get("etag");
  expect(etag).toMatch(/^W\/"[0-9a-f]{8}"$/);
  expect(Buffer.from(await assetResponse.arrayBuffer())).toEqual(PNG_1X1);

  const conditionalResponse = await fetch(
    `http://127.0.0.1:${address.port}${effectiveAssetPrefix}/_next/static/media/${emittedImage}`,
    { headers: { "if-none-match": etag! } },
  );
  expect(conditionalResponse.status).toBe(304);
  expect(conditionalResponse.headers.get("etag")).toBe(etag);
  expect(await conditionalResponse.text()).toBe("");
}

describe("static image import production emission", () => {
  afterAll(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await Promise.all(tempDirs.map((root) => rm(root, { recursive: true, force: true })));
  });

  // Ported from Next.js: test/e2e/app-dir/next-image/next-image.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-image/next-image.test.ts
  it("emits App Router static imports while preserving ordinary asset thresholds", async () => {
    await assertStaticImageProductionParity("app");
  }, 60_000);

  it("emits Pages Router static imports while preserving ordinary asset thresholds", async () => {
    await assertStaticImageProductionParity("pages");
  }, 60_000);

  it("preserves managed image URLs under basePath and assetPrefix", async () => {
    await assertStaticImageProductionParity("app", {
      basePath: "/docs",
      assetPrefix: "/cdn",
      deploymentId: "static-image-test",
    });
  }, 60_000);

  it("emits matching SSR and client image URLs in Cloudflare builds", async () => {
    const root = await createFixture("app");
    await buildCloudflareFixture(root);
    const mediaDir = path.join(root, "dist/client/_next/static/media");
    const emittedImage = (await readdir(mediaDir)).find((file) =>
      /^client\.[\w-]{8}\.png$/.test(file),
    );
    expect(emittedImage).toBeDefined();
    const serverJavaScript = await readBuiltJavaScript(path.join(root, "dist/server"));
    expect(serverJavaScript).toContain(`/_next/static/media/${emittedImage}`);
    expect(serverJavaScript).not.toMatch(/\/_next\/static\/client-[\w-]+\.png/);
  }, 60_000);

  it("recomputes changed images and removes deleted imports during watch rebuilds", async () => {
    const root = await mkdtemp(path.join(import.meta.dirname, ".tmp-static-image-watch-"));
    tempDirs.push(root);
    const outDir = path.join(root, "dist/client");
    const imagePath = path.join(root, "test.png");
    const entryPath = path.join(root, "entry.ts");
    writeFixtureFile(root, "test.png", PNG_1X1);
    writeFixtureFile(root, "entry.ts", `import image from "./test.png"; console.log(image.src);\n`);

    const watcher = (await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
      build: {
        outDir,
        emptyOutDir: true,
        watch: {},
        rolldownOptions: { input: entryPath },
      },
    })) as BuildWatcher;

    try {
      await waitForWatchBuild(watcher);
      const firstImage = await findEmittedImage(root);
      expect(await readFile(path.join(outDir, "_next/static/media", firstImage))).toEqual(PNG_1X1);

      const changedBuild = waitForWatchBuild(watcher, async () => {
        const emittedImage = await findEmittedImage(root);
        return emittedImage !== firstImage;
      });
      await fs.promises.writeFile(imagePath, PNG_4X3);
      await changedBuild;
      const secondImage = await findEmittedImage(root);
      expect(secondImage).not.toBe(firstImage);
      expect(await readFile(path.join(outDir, "_next/static/media", secondImage))).toEqual(PNG_4X3);
      expect(fs.existsSync(path.join(outDir, "_next/static/media", firstImage))).toBe(false);
      const changedJavaScript = await readBuiltJavaScript(outDir);
      expect(changedJavaScript).toContain(secondImage);
      expect(changedJavaScript).toMatch(/width:4[,}]|"width":4/);
      expect(changedJavaScript).toMatch(/height:3[,}]|"height":3/);

      const removedBuild = waitForWatchBuild(watcher, async () => {
        const builtJavaScript = await readBuiltJavaScript(outDir);
        return (
          !fs.existsSync(path.join(outDir, "_next/static/media", secondImage)) &&
          !builtJavaScript.includes(secondImage)
        );
      });
      await fs.promises.writeFile(entryPath, `console.log("no image");\n`);
      await removedBuild;
      expect(fs.existsSync(path.join(outDir, "_next/static/media", secondImage))).toBe(false);
      expect(await readBuiltJavaScript(outDir)).not.toContain(secondImage);
    } finally {
      await watcher.close();
    }
  }, 60_000);
});
