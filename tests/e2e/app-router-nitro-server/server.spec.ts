import http from "node:http";
import { test, expect } from "@playwright/test";

// tests/fixtures/app-router-nitro-server built with `vite build` and served by
// Nitro's Node server, which serves the static output itself.

test.describe("App Router on Nitro (node server)", () => {
  test("renders a page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("App Router on Nitro");
  });

  test("runs middleware before serving a public file", async ({ request }) => {
    const response = await request.get("/hello.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    expect(response.headers()["x-vinext-middleware"]).toBe("active");
    expect(await response.text()).toBe("Hello from public/\n");
  });

  test("lets middleware answer a request for a public file", async ({ request }) => {
    const response = await request.get("/blocked.txt");
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ middleware: true });
  });

  // h3 resolves these to /blocked.txt before Nitro's static handler looks
  // them up.
  test("runs middleware for an encoded path to a public file", async ({ request }) => {
    for (const path of ["/blocked.txt%5C", "/blocked%09.txt", "/x%5C..%5Cblocked.txt"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(404);
      expect(response.headers()["x-vinext-middleware"], path).toBe("active");
    }
  });

  test("serves a public file with # in its name", async ({ request }) => {
    const response = await request.get("/a%23b.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["x-vinext-middleware"]).toBe("active");
    expect(await response.text()).toBe("Hash in the name\n");
  });

  // HTTP clients drop a fragment, but Nitro's Node server keeps a literal `#`
  // in the request target, and its static handler would serve public/a#b.txt.
  // vinext reads the `#` as a fragment and answers 404 after middleware.
  test("runs middleware for a request target with a literal #", async ({ baseURL }) => {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get({ host: "localhost", port: new URL(baseURL!).port, path: "/a#b.txt" }, (res) => {
          res.resume();
          resolve(res);
        })
        .on("error", reject);
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["x-vinext-middleware"]).toBe("active");
  });

  test("serves a public file that a rewrite resolves to", async ({ request }) => {
    const response = await request.get("/rewrite-to-public");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    expect(response.headers()["x-vinext-middleware"]).toBe("active");
    expect(await response.text()).toBe("Hello from public/\n");
  });

  test("serves a public file that middleware's matcher excludes", async ({ request }) => {
    const response = await request.get("/unmatched.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["x-vinext-middleware"]).toBeUndefined();
    expect(await response.text()).toBe("Served without middleware\n");
  });

  // As in Next.js, a directory's index.html is served only at its own path.
  test("serves a public index.html only at its own path", async ({ request }) => {
    const file = await request.get("/docs/index.html");
    expect(file.status()).toBe(200);
    expect(file.headers()["x-vinext-middleware"]).toBe("active");
    expect(await file.text()).toContain("Docs from public/");

    const directory = await request.get("/docs");
    expect(directory.status()).toBe(404);
    expect(await directory.text()).not.toContain("Docs from public/");
  });
});
