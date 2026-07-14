import { expect, test } from "@playwright/test";

function optimizerUrl(source: string, quality = 75): string {
  const url = new URL("/_next/image", "http://127.0.0.1:4191");
  url.searchParams.set("url", source);
  url.searchParams.set("w", "32");
  url.searchParams.set("q", String(quality));
  return url.toString();
}

// Ported from Next.js image optimizer behavior in:
// test/integration/image-optimizer/test/util.ts and
// packages/next/src/server/image-optimizer.ts (fetchInternalImage/sendResponse).
// https://github.com/vercel/next.js/blob/canary/test/integration/image-optimizer/test/util.ts
test.describe("App Router production image source parity", () => {
  test("validates source bytes, honors config, and serves conditional requests", async ({
    request,
  }) => {
    await request.get("/image-test/reset");
    const url = optimizerUrl("/image-test/source.png?wrong-type=1");
    const initial = await request.get(url);
    expect(initial.status()).toBe(200);
    expect(initial.headers()["content-type"]).toContain("image/png");
    expect(initial.headers()["cache-control"]).toBe("public, max-age=200, must-revalidate");
    expect(initial.headers()["content-disposition"]).toBe('attachment; filename="source.png"');
    expect(initial.headers()["x-nextjs-cache"]).toBe("MISS");
    const initialBody = await initial.body();
    expect(initial.headers()["content-length"]).toBe(String(initialBody.byteLength));
    const etag = initial.headers().etag;
    expect(etag).toBeTruthy();

    const conditional = await request.get(url, { headers: { "if-none-match": etag } });
    expect(conditional.status()).toBe(304);
    expect((await conditional.body()).byteLength).toBe(0);
    expect(conditional.headers()["content-type"]).toBeUndefined();
    expect(conditional.headers()["content-disposition"]).toBeUndefined();
    expect(await (await request.get("/image-test/state")).json()).toEqual({
      count: 1,
      method: "GET",
    });

    for (const source of ["/image-test/source.png?auth=1", "/image-test/source.png?spoof=1"]) {
      const invalid = await request.get(optimizerUrl(source));
      expect(invalid.status()).toBe(400);
      expect(await invalid.text()).toContain("isn't a valid image");
    }
    expect((await request.get(optimizerUrl("/image-test/source.png?oversize=1"))).status()).toBe(
      413,
    );
  });

  test("reuses one buffered source and preserves POST while mapping HEAD to GET", async ({
    request,
  }) => {
    await request.get("/image-test/reset");
    const post = await request.fetch(optimizerUrl("/image-test/source.png?method=post"), {
      method: "POST",
    });
    expect(post.status()).toBe(200);
    const expectedContentLength = post.headers()["content-length"];
    expect(expectedContentLength).toBeTruthy();
    expect(await (await request.get("/image-test/state")).json()).toEqual({
      count: 1,
      method: "POST",
    });

    await request.get("/image-test/reset");
    const head = await request.fetch(optimizerUrl("/image-test/source.png?method=head"), {
      method: "HEAD",
    });
    expect(head.status()).toBe(200);
    expect((await head.body()).byteLength).toBe(0);
    expect(head.headers()["content-length"]).toBe(expectedContentLength);
    expect(head.headers()["content-disposition"]).toBe('attachment; filename="source.png"');
    expect(await (await request.get("/image-test/state")).json()).toEqual({
      count: 1,
      method: "GET",
    });
  });

  test("bounds public files and classifies build-owned static media as immutable", async ({
    request,
  }) => {
    expect((await request.get(optimizerUrl("/large-public.png"))).status()).toBe(413);
    const mutable = await request.get(optimizerUrl("/static/media/static-image.bmp"));
    expect(mutable.status()).toBe(200);
    expect(mutable.headers()["cache-control"]).toBe("public, max-age=3600, must-revalidate");

    const immutable = await request.get(optimizerUrl("/_next/static/media/static-image.bmp"));
    expect(immutable.status()).toBe(200);
    expect(immutable.headers()["cache-control"]).toBe("public, max-age=315360000, immutable");
    expect(immutable.headers()["content-disposition"]).toBe(
      'attachment; filename="static-image.bmp"',
    );
    expect(immutable.headers()["content-length"]).toBe(String((await immutable.body()).byteLength));

    const legacyImmutable = await request.get(
      optimizerUrl("/_next/static/immutable/media/static-image.bmp"),
    );
    expect(legacyImmutable.status()).toBe(200);
    expect(legacyImmutable.headers()["cache-control"]).toBe("public, max-age=315360000, immutable");

    for (const source of [
      "/%5Fnext/static/media/static-image.bmp",
      "/_next/static/%6dedia/static-image.bmp",
      "/_next/static/%69mmutable/media/static-image.bmp",
      "/_next/static/immutable/%6dedia/static-image.bmp",
    ]) {
      const encoded = await request.get(optimizerUrl(source));
      expect(encoded.status()).toBe(200);
      expect(encoded.headers()["cache-control"]).toBe("public, max-age=3600, must-revalidate");
    }
  });

  test("rejects nested optimizer source suffixes before middleware dispatch", async ({
    request,
  }) => {
    await request.get("/image-test/reset");
    for (const source of ["/_next/image/again", "/docs/_next/image/again"]) {
      expect((await request.get(optimizerUrl(source))).status()).toBe(400);
    }
    expect(await (await request.get("/image-test/state")).json()).toEqual({
      count: 0,
      method: "",
    });
  });

  // Ported from Next.js: test/integration/image-optimizer/test/util.ts
  // https://github.com/vercel/next.js/blob/canary/test/integration/image-optimizer/test/util.ts
  test("returns animated GIF, PNG, and WebP originals without transforming", async ({
    request,
  }) => {
    for (const [kind, contentType, signature] of [
      ["gif", "image/gif", [0x47, 0x49, 0x46]],
      ["png", "image/png", [0x89, 0x50, 0x4e, 0x47]],
      ["webp", "image/webp", [0x52, 0x49, 0x46, 0x46]],
    ] as const) {
      const response = await request.get(
        optimizerUrl(`/image-test/source.png?animated=${kind}`, 90),
      );
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain(contentType);
      expect([...(await response.body()).subarray(0, signature.length)]).toEqual(signature);
    }
  });
});
