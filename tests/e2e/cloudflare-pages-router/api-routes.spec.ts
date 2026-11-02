import { test, expect } from "@playwright/test";
import { testPagesApiBodyCharsets } from "../pages-api-body-charset";

const BASE = "http://localhost:4177";

test.describe("Pages Router API routes on Cloudflare Workers", () => {
  test("API route returns JSON", async ({ request }) => {
    const res = await request.get(BASE + "/api/hello");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.message).toBe("Hello from Pages Router API on Workers!");
  });

  test("API route reports Cloudflare Workers runtime", async ({ request }) => {
    const res = await request.get(BASE + "/api/hello");
    const data = await res.json();
    expect(data.runtime).toBe("Cloudflare-Workers");
  });

  test("API route pipes a Node stream passed to res.send()", async ({ request }) => {
    const res = await request.get(BASE + "/api/send-stream");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/octet-stream");
    expect(await res.text()).toBe("hello from a stream");

    const typed = await request.get(BASE + "/api/send-stream?contentType=text/event-stream");
    expect(typed.headers()["content-type"]).toBe("text/event-stream");
    expect(await typed.text()).toBe("hello from a stream");

    for (const status of [204, 205, 304]) {
      const empty = await request.get(
        `${BASE}/api/send-stream?status=${status}&contentType=text/plain`,
      );
      expect(empty.status()).toBe(status);
      expect(empty.headers()["content-type"]).toBeUndefined();
      expect(await empty.text()).toBe("");
    }
  });

  test("returns 404 for non-existent API routes", async ({ request }) => {
    const res = await request.get(BASE + "/api/nonexistent");
    expect(res.status()).toBe(404);
  });

  testPagesApiBodyCharsets(BASE);
});
