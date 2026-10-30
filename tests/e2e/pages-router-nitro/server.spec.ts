import { test, expect } from "@playwright/test";
import { getWithHost, startRewriteUpstream } from "../helpers";

// tests/fixtures/pages-router-nitro built with `vite build` and served by
// Nitro's Node server.

test.describe("Pages Router on Nitro (node server)", () => {
  test("renders a page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Pages Router on Nitro");
  });

  test("runs proxy before serving a public file", async ({ request }) => {
    const response = await request.get("/hello.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    expect(response.headers()["x-vinext-proxy"]).toBe("active");
    expect(await response.text()).toBe("Hello from public/\n");
  });

  test("lets proxy answer a request for a public file", async ({ request }) => {
    const response = await request.get("/blocked.txt");
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ proxy: true });
  });

  // h3 resolves these to /blocked.txt before Nitro's static handler looks
  // them up.
  test("runs proxy for an encoded path to a public file", async ({ request }) => {
    for (const path of ["/blocked.txt%5C", "/blocked%09.txt", "/x%5C..%5Cblocked.txt"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(404);
      expect(response.headers()["x-vinext-proxy"], path).toBe("active");
    }
  });

  test("serves a public file that a rewrite resolves to", async ({ request }) => {
    const response = await request.get("/rewrite-to-public");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    expect(response.headers()["x-vinext-proxy"]).toBe("active");
    expect(await response.text()).toBe("Hello from public/\n");
  });

  test("answers HEAD for a public file that a rewrite resolves to", async ({ request }) => {
    const response = await request.head("/rewrite-to-public");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-length"]).toBe("19");
    expect(await response.text()).toBe("");
  });

  test("serves a public image from the image endpoint", async ({ request }) => {
    const response = await request.get("/_next/image?url=%2Fpixel.png&w=64&q=75");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect((await response.body()).subarray(1, 4).toString()).toBe("PNG");
  });

  // Next.js decides whether a proxy rewrite is external against its own
  // hostname and port. Nitro's Node server builds the request URL from the
  // Host header, which must not make a rewrite to the host it names internal
  // and serve the target path without proxy's check for it.
  test("a Host header cannot turn an external proxy rewrite into an internal one", async ({
    baseURL,
  }) => {
    const upstream = await startRewriteUpstream();
    try {
      const attack = await getWithHost(baseURL!, "/legacy/blocked.txt", upstream.host, {
        "x-legacy-origin": `http://${upstream.host}`,
      });
      expect({ status: attack.status, body: attack.body }).toEqual({
        status: 200,
        body: "external upstream",
      });
      expect(upstream.hits).toEqual(["/blocked.txt"]);
    } finally {
      await upstream.close();
    }

    // Proxy's `new URL(path, request.url)` rewrites stay internal for any Host.
    const rewritten = await getWithHost(baseURL!, "/rewrite-to-hello", "public.example");
    expect({ status: rewritten.status, body: rewritten.body }).toEqual({
      status: 200,
      body: "Hello from public/\n",
    });
  });
});
