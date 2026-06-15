import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { build, createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8n26QAAAABJRU5ErkJggg==",
  "base64",
);

const tempDirs: string[] = [];
const servers: Server[] = [];

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
  writeFixtureFile(root, "test.png", PNG_1X1);
  writeFixtureFile(root, "tiny.png", PNG_1X1);
  if (options.basePath || options.assetPrefix || options.deploymentId) {
    writeFixtureFile(root, "next.config.mjs", `export default ${JSON.stringify(options)};\n`);
  }

  const imageMarkup = `
      <Image id="static-image" alt="static import" src={staticImage} quality={85} />
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
import staticImage from "../test.png";

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

function getAttribute(html: string, id: string, attribute: string): string {
  const tag = html.match(new RegExp(`<img\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
  const value = tag?.match(new RegExp(`\\b${attribute}="([^"]+)"`, "i"))?.[1];
  if (!value) throw new Error(`Missing ${attribute} on image #${id}`);
  return value.replaceAll("&amp;", "&");
}

async function findEmittedImage(root: string, assetPrefix = ""): Promise<string> {
  const prefixPath = assetPrefix.startsWith("http")
    ? ""
    : assetPrefix.split("/").filter(Boolean).join("/");
  const mediaDir = path.join(root, "dist/client", prefixPath, "_next/static/media");
  const files = await readdir(mediaDir);
  const image = files.find((file) => /^test\.[\w-]{8}\.png$/.test(file));
  if (!image) throw new Error(`Missing emitted test image in ${mediaDir}: ${files.join(", ")}`);
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
  const prefixPath = effectiveAssetPrefix.split("/").filter(Boolean).join("/");
  expect(
    await readFile(path.join(root, "dist/client", prefixPath, "_next/static/media", emittedImage)),
  ).toEqual(PNG_1X1);

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

  for (const id of router === "app" ? ["static-image", "client-static-image"] : ["static-image"]) {
    const src = getAttribute(html, id, "src");
    const srcset = getAttribute(html, id, "srcset");
    const managedUrl = `${effectiveAssetPrefix}/_next/static/media/${emittedImage}`;
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
  const assetResponse = await fetch(
    `http://127.0.0.1:${address.port}${effectiveAssetPrefix}/_next/static/media/${emittedImage}`,
  );
  expect(assetResponse.status).toBe(200);
  expect(Buffer.from(await assetResponse.arrayBuffer())).toEqual(PNG_1X1);
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
});
