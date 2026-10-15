import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, type APIResponse } from "@playwright/test";
import { defineNitroAppTests } from "./app-tests";

function getWithHost(url: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
  });
}

// examples/app-router-nitro built with `vite build` and served by
// `vite preview`, which runs Nitro's own server output (#853).

test.describe("App Router on Nitro (vite preview)", () => {
  defineNitroAppTests();

  // `revalidate` pages are cached by vinext's own ISR cache, not by Nitro
  // route rules.
  test("serves revalidate pages from the ISR cache", async ({ request }) => {
    const renderedAt = async (response: APIResponse) =>
      /data-testid="isr-timestamp"[^>]*>Rendered at: (?:<!-- -->)?([^<]+)</.exec(
        await response.text(),
      )?.[1];

    // The cache write lands after the response stream finishes, so poll for
    // the first HIT before asserting that a later request replays it.
    let hit: APIResponse | undefined;
    await expect
      .poll(
        async () => {
          hit = await request.get("/isr");
          return hit.headers()["x-vinext-cache"];
        },
        { timeout: 5_000, intervals: [50, 100, 250] },
      )
      .toBe("HIT");
    const hitRenderedAt = await renderedAt(hit!);
    expect(hitRenderedAt).toBeTruthy();

    const replay = await request.get("/isr");
    expect(replay.status()).toBe(200);
    expect(replay.headers()["x-vinext-cache"]).toBe("HIT");
    expect(await renderedAt(replay)).toBe(hitRenderedAt);
  });

  // Pages `res.revalidate()` in a hybrid app. Nitro's Node server builds
  // request.url from the client Host header, so the revalidation credential
  // must never be sent to that origin.
  test("res.revalidate() regenerates in-process, not at the Host origin", async ({
    baseURL,
    request,
  }) => {
    const received: string[] = [];
    const recorder = http.createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      res.end();
    });
    await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve));
    const recorderHost = `127.0.0.1:${(recorder.address() as AddressInfo).port}`;
    const renderedAt = async () =>
      /data-testid="pages-isr-timestamp"[^>]*>Rendered at: (?:<!-- -->)?([^<]+)</.exec(
        await (await request.get("/pages-isr")).text(),
      )?.[1];

    try {
      await expect
        .poll(async () => (await request.get("/pages-isr")).headers()["x-vinext-cache"], {
          timeout: 5_000,
          intervals: [50, 100, 250],
        })
        .toBe("HIT");
      const before = await renderedAt();
      expect(before).toBeTruthy();

      const response = await getWithHost(`${baseURL}/api/revalidate`, recorderHost);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ revalidated: true });
      expect(received).toEqual([]);
      const after = await renderedAt();
      expect(after).toBeTruthy();
      expect(after).not.toBe(before);
    } finally {
      recorder.closeAllConnections();
      await new Promise<void>((resolve) => recorder.close(() => resolve()));
    }
  });
});
