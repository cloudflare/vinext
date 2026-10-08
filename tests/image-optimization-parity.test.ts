import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { Server } from "node:http";
import { build, type ViteDevServer } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import {
  APP_FIXTURE_DIR,
  PAGES_FIXTURE_DIR,
  requestNodeServerWithHost,
  startFixtureServer,
} from "./helpers.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8n26QAAAABJRU5ErkJggg==",
  "base64",
);

async function createImageFixture(router: "app" | "pages"): Promise<string> {
  const baseFixtureDir = router === "app" ? APP_FIXTURE_DIR : PAGES_FIXTURE_DIR;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `vinext-${router}-image-parity-`));
  await fs.cp(baseFixtureDir, rootDir, { recursive: true });
  try {
    await fs.access(path.join(rootDir, "node_modules"));
  } catch {
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(rootDir, "node_modules"),
      "junction",
    );
  }
  await fs.mkdir(path.join(rootDir, "public"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "public", "äöüščří.png"), PNG_1X1);
  await fs.writeFile(path.join(rootDir, "public", "hello world.png"), PNG_1X1);

  if (router === "app") {
    await fs.rm(path.join(rootDir, "app", "alias-test"), { recursive: true, force: true });
    await fs.rm(path.join(rootDir, "app", "baseurl-test"), { recursive: true, force: true });
    await fs.mkdir(path.join(rootDir, "app", "image-parity"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "app", "image-parity", "page.tsx"),
      `import Image from "next/image";

export default function Page() {
  return (
    <main>
      <Image alt="unicode" src="/äöüščří.png" width={64} height={64} />
      <Image alt="space" src="/hello world.png" width={64} height={64} />
    </main>
  );
}
`,
    );
  } else {
    await fs.mkdir(path.join(rootDir, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "pages", "image-parity.tsx"),
      `import Image from "next/image";

export default function Page() {
  return (
    <main>
      <Image alt="unicode" src="/äöüščří.png" width={64} height={64} />
      <Image alt="space" src="/hello world.png" width={64} height={64} />
    </main>
  );
}
`,
    );
  }

  return rootDir;
}

function getImageSrcFromHtml(html: string, alt: string): string {
  for (const match of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = match[0];
    if (!tag.includes(`alt="${alt}"`)) continue;
    const srcMatch = tag.match(/\ssrc="([^"]+)"/);
    if (srcMatch) return srcMatch[1].replaceAll("&amp;", "&");
  }

  throw new Error(`Could not find <img> tag for alt="${alt}"`);
}

async function fetchHtmlWithRetry(baseUrl: string, pagePath: string): Promise<string> {
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${baseUrl}${pagePath}`);
    const body = await res.text();
    if (res.status === 200) return body;
    lastStatus = res.status;
    lastBody = body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Expected ${pagePath} to return 200, got ${lastStatus}: ${lastBody.slice(0, 500)}`,
  );
}

function runLocalImageUrlParitySuite(router: "app" | "pages"): void {
  describe(`${router === "app" ? "App" : "Pages"} Router next/image local URL parity`, () => {
    let server: ViteDevServer;
    let baseUrl: string;
    let fixtureDir: string;

    beforeAll(async () => {
      fixtureDir = await createImageFixture(router);
      ({ server, baseUrl } = await startFixtureServer(fixtureDir, { appRouter: router === "app" }));
    }, 30000);

    afterAll(async () => {
      await server?.close();
      await fs.rm(fixtureDir, { recursive: true, force: true });
    });

    // Ported from Next.js: test/integration/next-image-new/unicode/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/integration/next-image-new/unicode/test/index.test.ts
    it("serves internal unicode image URLs through the optimizer route", async () => {
      const pagePath = "/image-parity";
      const html = await fetchHtmlWithRetry(baseUrl, pagePath);
      const src = getImageSrcFromHtml(html, "unicode");
      const imageUrl = new URL(src, baseUrl);

      expect(imageUrl.pathname).toBe("/_next/image");
      expect(imageUrl.searchParams.get("url")).toBe("/äöüščří.png");
      expect(imageUrl.searchParams.get("w")).toBe("128");
      expect(imageUrl.searchParams.get("q")).toBe("75");

      const res = await fetch(imageUrl);
      expect(res.status).toBe(200);
    });

    // Ported from Next.js: test/integration/next-image-new/unicode/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/integration/next-image-new/unicode/test/index.test.ts
    it("serves internal image URLs with spaces through the optimizer route", async () => {
      const pagePath = "/image-parity";
      const html = await fetchHtmlWithRetry(baseUrl, pagePath);
      const src = getImageSrcFromHtml(html, "space");
      const imageUrl = new URL(src, baseUrl);

      expect(imageUrl.pathname).toBe("/_next/image");
      expect(imageUrl.searchParams.get("url")).toBe("/hello world.png");
      expect(imageUrl.searchParams.get("w")).toBe("128");
      expect(imageUrl.searchParams.get("q")).toBe("75");

      const res = await fetch(imageUrl);
      expect(res.status).toBe(200);
    });

    // Both /_next/image and /_vinext/image are accepted so apps wired to
    // either prefix get images served through the same optimizer pipeline.
    it("routes /_vinext/image requests through the optimizer", async () => {
      const vinextUrl = new URL("/_vinext/image", baseUrl);
      vinextUrl.searchParams.set("url", "/hello world.png");
      vinextUrl.searchParams.set("w", "64");
      vinextUrl.searchParams.set("q", "75");
      const res = await fetch(vinextUrl);
      expect(res.status).toBe(200);
    });
  });
}

describe("image deployment query parity", () => {
  it("accepts Next.js deployment IDs without including them in the source path", async () => {
    const { parseImageParams } =
      await import("../packages/vinext/src/server/image-optimization.js");
    const requestUrl = new URL(
      "http://vinext.test/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Ftest.hash.png&w=828&q=85&dpl=deploy-1",
    );

    expect(parseImageParams(requestUrl)).toEqual({
      imageUrl: "/_next/static/media/test.hash.png",
      width: 828,
      quality: 85,
    });
  });
});

runLocalImageUrlParitySuite("app");
runLocalImageUrlParitySuite("pages");

// Ported from Next.js: test/integration/image-optimizer/test/util.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/integration/image-optimizer/test/util.ts
// The Pages Router production server answers `/_next/image` itself. vinext
// keeps no image cache, so it matches Next.js with the image cache disabled
// (`images.maximumDiskCacheSize: 0`): every 200 is a MISS.
describe("Pages Router production /_next/image cache-state headers", () => {
  let server: Server | undefined;
  let baseUrl: string;
  let fixtureDir: string;

  beforeAll(async () => {
    // A minimal Pages Router app: the image endpoint only needs public files,
    // and the full pages-basic fixture does not build outside its directory.
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-image-prod-"));
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(fixtureDir, "node_modules"),
      "junction",
    );
    await fs.mkdir(path.join(fixtureDir, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(fixtureDir, "pages", "index.jsx"),
      "export default function Page() {\n  return <p>home</p>;\n}\n",
    );
    await fs.mkdir(path.join(fixtureDir, "public"), { recursive: true });
    await fs.writeFile(path.join(fixtureDir, "public", "hello world.png"), PNG_1X1);
    await fs.writeFile(path.join(fixtureDir, "public", "icon.svg"), "<svg></svg>");
    const outDir = path.join(fixtureDir, "dist");
    await build({
      root: fixtureDir,
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
      root: fixtureDir,
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
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const started = await startProdServer({ port: 0, host: "127.0.0.1", outDir });
    server = "server" in started ? started.server : started;
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Expected production server port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it("labels every image response MISS", async () => {
    const imageUrl = `${baseUrl}/_next/image?url=%2Fhello%20world.png&w=64&q=75`;

    const first = await fetch(imageUrl, { headers: { Accept: "image/webp" } });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-nextjs-cache")).toBe("MISS");
    expect(first.headers.get("x-vinext-cache")).toBe("MISS");
    await first.arrayBuffer();

    const repeat = await fetch(imageUrl, { headers: { Accept: "image/webp" } });
    expect(repeat.status).toBe(200);
    expect(repeat.headers.get("x-nextjs-cache")).toBe("MISS");
    expect(repeat.headers.get("x-vinext-cache")).toBe("MISS");
    await repeat.arrayBuffer();
  });

  it("sends no x-nextjs-cache or x-vinext-cache on a 304 or an error", async () => {
    const imagePath = "/_next/image?url=%2Fhello%20world.png&w=64&q=75";
    const first = await fetch(`${baseUrl}${imagePath}`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    await first.arrayBuffer();

    // fetch() adds `Cache-Control: no-cache` to conditional requests, which
    // forces a full response, so revalidate over raw HTTP like a browser does.
    const notModified = await requestNodeServerWithHost(
      Number(new URL(baseUrl).port),
      imagePath,
      new URL(baseUrl).host,
      { "If-None-Match": etag! },
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers["x-nextjs-cache"]).toBeUndefined();
    expect(notModified.headers["x-vinext-cache"]).toBeUndefined();

    for (const [query, status] of [
      ["url=%2Fhello%20world.png&w=65&q=75", 400],
      ["url=%2Ficon.svg&w=64&q=75", 400],
      ["url=%2Fmissing.png&w=64&q=75", 404],
    ] as const) {
      const res = await fetch(`${baseUrl}/_next/image?${query}`);
      expect(res.status, query).toBe(status);
      expect(res.headers.get("x-nextjs-cache"), query).toBeNull();
      expect(res.headers.get("x-vinext-cache"), query).toBeNull();
      await res.arrayBuffer();
    }
  });
});
