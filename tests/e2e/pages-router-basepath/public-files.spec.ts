import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4190";

// next/image emits the trailing-slash endpoint when trailingSlash is set.
const imagePath = (source: string) =>
  `${BASE}/docs/_next/image/?url=${encodeURIComponent(source)}&w=64&q=75`;

// Next.js answers a local source that yields no image with this 400.
const INVALID_IMAGE = "The requested resource isn't a valid image.";

// Next.js' filesystem lookup returns no item for a path outside basePath
// (getItem in packages/next/src/server/lib/router-utils/filesystem.ts), so
// public files exist only under basePath, where basePath-prefixed middleware
// matchers apply to them.
test.describe("public files outside basePath", () => {
  test("serves public files only under basePath", async ({ request }) => {
    const open = await request.get(`${BASE}/docs/open.txt`, { maxRedirects: 0 });
    expect(open.status()).toBe(200);
    expect(await open.text()).toBe("open file\n");

    const outside = await request.get(`${BASE}/open.txt`, { maxRedirects: 0 });
    expect(outside.status()).toBe(404);
    expect(await outside.text()).not.toContain("open file");
    // Next.js keeps a matching basePath: false header on the 404.
    expect(outside.headers()["x-outside-basepath"]).toBe("1");
  });

  test("does not bypass a middleware matcher by omitting basePath", async ({ request }) => {
    const gated = await request.get(`${BASE}/docs/private/report.txt`, { maxRedirects: 0 });
    expect(gated.status()).toBe(403);
    expect(await gated.text()).toBe("blocked by middleware");

    const outside = await request.get(`${BASE}/private/report.txt`, { maxRedirects: 0 });
    expect(outside.status()).toBe(404);
    expect(await outside.text()).not.toContain("private report");
  });

  test("resolves an image source only under basePath", async ({ request }) => {
    const admitted = await request.get(imagePath("/docs/pixel.png"), { maxRedirects: 0 });
    expect(admitted.status()).toBe(200);
    expect(admitted.headers()["content-type"]).toBe("image/png");

    for (const source of [
      "/pixel.png",
      "/private/photo.png",
      // Middleware denies this source under basePath.
      "/docs/private/photo.png",
    ]) {
      const image = await request.get(imagePath(source), { maxRedirects: 0 });
      expect(image.status(), source).toBe(400);
      expect(await image.text(), source).toBe(INVALID_IMAGE);
      expect(image.headers()["content-type"] ?? "", source).not.toContain("image/");
    }
  });
});

// Next.js' resolve-routes matches files and pages only for a pathname under
// basePath, so a middleware rewrite resolves only a basePath-prefixed target.
test.describe("middleware rewrites outside basePath", () => {
  test("resolves nothing for an unprefixed destination", async ({ request }) => {
    const file = await request.get(`${BASE}/docs/mw-rewrite/outside-file/`, { maxRedirects: 0 });
    expect(file.status()).toBe(404);
    expect(await file.text()).not.toContain("open file");

    const page = await request.get(`${BASE}/docs/mw-rewrite/outside-page/`, { maxRedirects: 0 });
    expect(page.status()).toBe(404);
    expect(await page.text()).not.toContain("hello page");
  });

  test("resolves a destination under basePath", async ({ request }) => {
    const file = await request.get(`${BASE}/docs/mw-rewrite/inside-file/`, { maxRedirects: 0 });
    expect(file.status()).toBe(200);
    expect(await file.text()).toBe("open file\n");

    const page = await request.get(`${BASE}/docs/mw-rewrite/inside-page/`, { maxRedirects: 0 });
    expect(page.status()).toBe(200);
    expect(await page.text()).toContain("hello page");
  });
});
