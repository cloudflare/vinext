import { expect, test, type APIRequestContext } from "@playwright/test";

// Ported from Next.js: test/integration/image-optimizer/test/util.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/integration/image-optimizer/test/util.ts
// What `imageOptimizer` in packages/next/src/server/image-optimizer.ts does
// with each kind of source, against the Cloudflare Images binding. Each
// expectation was observed with `next start` on next@16.2.7 for the same file.
//
// The Worker detects animation as a GIF, PNG or WebP source streams in and
// keeps only its first 1 MiB to replay. Some sources here are padded so that
// detection decides before the source ends, or reads past what it keeps and
// fetches the source again.

const imagePath = (source: string) => `/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`;
const REVALIDATED = "public, max-age=14400, must-revalidate";
const IMAGE_CSP = "script-src 'none'; frame-src 'none'; sandbox;";

/** The canvas width of a WebP image, from its VP8, VP8L or VP8X header. */
function webpWidth(bytes: Buffer): number {
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") return 1 + bytes.readUIntLE(24, 3);
  if (chunk === "VP8L") return 1 + (bytes.readUInt16LE(21) & 0x3fff);
  if (chunk === "VP8 ") return bytes.readUInt16LE(26) & 0x3fff;
  throw new Error(`Not a WebP image: ${chunk}`);
}

/** A source transformed to WebP, which must succeed. */
async function transformed(request: APIRequestContext, source: string): Promise<Buffer> {
  const response = await request.get(imagePath(source), {
    headers: { Accept: "image/webp,*/*" },
    maxRedirects: 0,
  });
  expect(response.status(), source).toBe(200);
  expect(response.headers()["content-type"], source).toBe("image/webp");
  return Buffer.from(await response.body());
}

async function original(request: APIRequestContext, source: string): Promise<Buffer> {
  const response = await request.get(source);
  expect(response.status(), source).toBe(200);
  return Buffer.from(await response.body());
}

test.describe("Cloudflare Workers /_next/image optimizes still images", () => {
  for (const [source, why] of [
    ["/image-still.jpg", "a format detection skips"],
    ["/image-still.webp", "a still WebP, read to its end"],
  ] as const) {
    test(`transforms ${source}: ${why}`, async ({ request }) => {
      const sourceBytes = await original(request, source);
      const response = await request.get(imagePath(source), {
        headers: { Accept: "image/webp,*/*" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe("image/webp");
      const body = Buffer.from(await response.body());
      expect(body.equals(sourceBytes)).toBe(false);
      // The binding decoded the whole source and resized it.
      expect(webpWidth(body)).toBeGreaterThan(0);
      expect(webpWidth(body)).toBeLessThanOrEqual(64);
      expect(response.headers()["content-security-policy"]).toBe(IMAGE_CSP);
      expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    });
  }

  // Detection decides at the PNG's first IDAT, 54 bytes in. Its pixel data, in
  // 97 uncompressed IDAT chunks, mostly streams in after that, so the bytes
  // detection kept must reach the optimizer followed by the rest of the
  // source. A compact copy of the same pixels, read whole, must transform to
  // the same image.
  test("transforms a PNG streamed on past where detection decided", async ({ request }) => {
    const streamed = await transformed(request, "/image-still-stored.png");
    expect(webpWidth(streamed)).toBe(64);
    expect(streamed.equals(await transformed(request, "/image-still-compact.png"))).toBe(true);
  });

  // ~1.2 MB of comment precedes this GIF's only frame, so detection reads past
  // the 1 MiB it keeps before finding the trailer, and the source is fetched
  // again. The frame comes from that second fetch, so the GIF must transform
  // to the same image as its copy without the comment.
  test("transforms a GIF fetched again with its frame past 1 MiB", async ({ request }) => {
    const refetched = await transformed(request, "/image-still-large.gif");
    expect(refetched.equals(await transformed(request, "/image-still.gif"))).toBe(true);
  });
});

test.describe("Cloudflare Workers /_next/image serves animated images as-is", () => {
  for (const [source, contentType, cacheControl, why] of [
    ["/image-animated.webp", "image/webp", REVALIDATED, "decided at its ANIM chunk"],
    ["/image-animated.png", "image/png", REVALIDATED, "an APNG, read to its end"],
    // next.config.mjs gives it a longer max-age, which Next.js keeps over
    // minimumCacheTTL.
    [
      "/image-animated-large.gif",
      "image/gif",
      "public, max-age=86400, must-revalidate",
      "its second frame past 1 MiB, so fetched again",
    ],
  ] as const) {
    test(`serves ${source} unchanged: ${why}`, async ({ request }) => {
      const sourceBytes = await original(request, source);
      const response = await request.get(imagePath(source), {
        headers: { Accept: "image/avif,image/webp,*/*" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe(contentType);
      expect(Buffer.from(await response.body()).equals(sourceBytes)).toBe(true);
      expect(response.headers()["cache-control"]).toBe(cacheControl);
      expect(response.headers()["vary"]).toBe("Accept");
      expect(response.headers()["content-security-policy"]).toBe(IMAGE_CSP);
      expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    });
  }
});

test.describe("Cloudflare Workers /_next/image when the optimizer fails", () => {
  // Next.js serves the source it could not optimize as-is, cached for
  // minimumCacheTTL alone: the corrupt PNG's own max-age of 86400 is dropped.
  for (const [source, contentType] of [
    ["/image-corrupt.png", "image/png"],
    ["/image-corrupt.jpg", "image/jpeg"],
  ] as const) {
    test(`serves ${source} as-is for minimumCacheTTL`, async ({ request }) => {
      const sourceBytes = await original(request, source);
      const response = await request.get(imagePath(source), {
        headers: { Accept: "image/webp,*/*" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe(contentType);
      expect(Buffer.from(await response.body()).equals(sourceBytes)).toBe(true);
      expect(response.headers()["cache-control"]).toBe(REVALIDATED);
      expect(response.headers()["content-security-policy"]).toBe(IMAGE_CSP);
    });
  }
});

test.describe("Cloudflare Workers /_next/image images.maximumResponseBody", () => {
  // next.config.mjs sets the limit to 2,000,000 bytes. Next.js's internal
  // image fetch answers 413 past it (`fetchInternalImage`); `next start` on
  // next@16.2.7 leaves the request hanging on an unhandled rejection instead.
  // The limit holds for every type, and comes before the type check, so an
  // SVG past it is a 413 even without dangerouslyAllowSVG.
  for (const source of [
    "/image-too-large.gif",
    "/image-too-large.jpg",
    "/image-too-large.svg",
    "/image-too-large-svg.png",
  ]) {
    test(`answers 413 for ${source} past the limit`, async ({ request }) => {
      const response = await request.get(imagePath(source), {
        headers: { Accept: "image/webp,*/*" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(413);
      expect(await response.text()).toBe(
        '"url" parameter is valid but internal response is invalid',
      );
    });
  }
});
