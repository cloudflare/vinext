import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("res.send() with a Node stream", () => {
  test("pipes the stream bytes with a default octet-stream Content-Type", async ({ request }) => {
    const response = await request.get(`${BASE}/api/send-stream`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/octet-stream");
    expect(await response.text()).toBe("hello from a stream");
  });

  test("keeps a Content-Type the handler set before sending", async ({ request }) => {
    const response = await request.get(`${BASE}/api/send-stream?contentType=text/event-stream`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/event-stream");
    expect(await response.text()).toBe("hello from a stream");
  });
});
