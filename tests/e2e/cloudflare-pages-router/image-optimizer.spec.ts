import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-pages-router/image-fixture`;
const BASE_URL = "http://localhost:4195";
let server: ChildProcess;

function optimizerUrl(source: string, quality = 75): string {
  const url = new URL("/_next/image", BASE_URL);
  url.searchParams.set("url", source);
  url.searchParams.set("w", "32");
  url.searchParams.set("q", String(quality));
  return url.toString();
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Pages Worker exited with ${server.exitCode}`);
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for Pages Worker image fixture");
}

test.describe("Cloudflare Pages Router image optimizer", () => {
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/pages-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; npx vp build && npx wrangler dev --port 4195",
      { cwd: FIXTURE_DIR, shell: true, stdio: "inherit" },
    );
    await waitForServer();
  });

  test.afterAll(() => server.kill());

  test("validates, caches, conditions, and buffers a single internal source", async ({
    request,
  }) => {
    await request.get(`${BASE_URL}/image-test/reset`);
    const url = optimizerUrl("/image-test/source.png");
    const initial = await request.get(url);
    expect(initial.status()).toBe(200);
    expect(initial.headers()["content-type"]).toContain("image/png");
    expect(initial.headers()["cache-control"]).toBe("public, max-age=123, must-revalidate");
    expect(initial.headers()["content-disposition"]).toBe('attachment; filename="source.png"');
    expect(initial.headers()["x-nextjs-cache"]).toBe("MISS");
    expect(initial.headers()["content-length"]).toBe(String((await initial.body()).byteLength));
    const etag = initial.headers().etag;
    expect(etag).toBeTruthy();
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 1,
      method: "GET",
    });

    const conditional = await request.get(url, { headers: { "if-none-match": etag } });
    expect(conditional.status()).toBe(304);
    expect((await conditional.body()).byteLength).toBe(0);
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 1,
      method: "GET",
    });
    expect((await request.get(optimizerUrl("/image-test/source.png?spoof=1"))).status()).toBe(400);
    expect((await request.get(optimizerUrl("/image-test/source.png?oversize=1"))).status()).toBe(
      413,
    );

    await request.get(`${BASE_URL}/image-test/reset`);
    expect(
      (
        await request.fetch(optimizerUrl("/image-test/source.png?method=post"), {
          method: "POST",
        })
      ).status(),
    ).toBe(200);
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 1,
      method: "POST",
    });
  });

  test("bounds public assets and classifies build-owned static media as immutable", async ({
    request,
  }) => {
    expect((await request.get(optimizerUrl("/large-public.png"))).status()).toBe(413);
    const mutable = await request.get(optimizerUrl("/static/media/static-image.bmp"));
    expect(mutable.status()).toBe(200);
    expect(mutable.headers()["cache-control"]).toBe("public, max-age=123, must-revalidate");

    const immutable = await request.get(optimizerUrl("/_next/static/media/static-image.bmp"));
    expect(immutable.status()).toBe(200);
    expect(immutable.headers()["cache-control"]).toBe("public, max-age=315360000, immutable");
    expect(immutable.headers()["content-disposition"]).toBe(
      'attachment; filename="static-image.bmp"',
    );

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
      expect(encoded.headers()["cache-control"]).toBe("public, max-age=31536000, must-revalidate");
    }
  });

  test("negotiates configured formats and reuses each cached representation", async ({
    request,
  }) => {
    await request.get(`${BASE_URL}/image-test/reset`);
    const url = optimizerUrl("/image-test/source.png?format=weighted", 90);
    const avif = await request.get(url, {
      headers: { accept: "image/avif;q=0.9,image/webp;q=0.4" },
    });
    expect(avif.headers()["content-type"]).toContain("image/avif");
    expect(avif.headers()["x-nextjs-cache"]).toBe("MISS");
    expect(await avif.text()).toBe("format:image/avif");

    const webp = await request.get(url, {
      headers: { accept: "image/avif;q=0.2,image/webp;q=0.8" },
    });
    expect(webp.headers()["content-type"]).toContain("image/webp");
    expect(webp.headers()["x-nextjs-cache"]).toBe("MISS");

    const cachedAvif = await request.get(url, { headers: { accept: "image/avif" } });
    expect(cachedAvif.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 2,
      method: "GET",
    });
  });
});
