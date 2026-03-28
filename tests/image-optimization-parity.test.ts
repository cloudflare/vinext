import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, PAGES_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

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

      expect(imageUrl.pathname).toBe("/_vinext/image");
      expect(imageUrl.searchParams.get("url")).toBe("/äöüščří.png");
      expect(imageUrl.searchParams.get("w")).toBe("64");
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

      expect(imageUrl.pathname).toBe("/_vinext/image");
      expect(imageUrl.searchParams.get("url")).toBe("/hello world.png");
      expect(imageUrl.searchParams.get("w")).toBe("64");
      expect(imageUrl.searchParams.get("q")).toBe("75");

      const res = await fetch(imageUrl);
      expect(res.status).toBe(200);
    });
  });
}

runLocalImageUrlParitySuite("app");
runLocalImageUrlParitySuite("pages");
