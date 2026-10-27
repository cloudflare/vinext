import { expect, test } from "@playwright/test";

// next@16.2.7 apiResolver `sendData` tags every buffered send with
// generateETag(body), hashing a Buffer's JSON form, and answers a fresh
// conditional request with a bodyless 304. The expected values below are
// Next.js's own ETags for these fixture bodies.
const HELLO_ETAG = '"s8zpq92b28t"';
const SEND_BUFFER_ETAG = '"kptswdn584w"';

export function testPagesApiEtags(fallbackBaseURL: string): void {
  test.describe("Pages API ETags", () => {
    test("res.json() answers a matching If-None-Match with a 304", async ({ baseURL, request }) => {
      const base = baseURL ?? fallbackBaseURL;
      const url = `${base}/api/hello`;
      const first = await request.get(url);
      expect(first.status()).toBe(200);
      expect(first.headers()["etag"]).toBe(HELLO_ETAG);

      for (const ifNoneMatch of [HELLO_ETAG, `W/${HELLO_ETAG}`, "*"]) {
        const revalidated = await request.get(url, {
          headers: { "If-None-Match": ifNoneMatch },
        });
        expect(revalidated.status(), ifNoneMatch).toBe(304);
        expect(revalidated.headers()["etag"]).toBe(HELLO_ETAG);
        expect(await revalidated.body()).toHaveLength(0);
      }
    });

    test("res.json() sends the body when the request is not fresh", async ({
      baseURL,
      request,
    }) => {
      const base = baseURL ?? fallbackBaseURL;
      const url = `${base}/api/hello`;
      const staleRequests: Record<string, string>[] = [
        { "If-None-Match": '"other"' },
        { "If-None-Match": HELLO_ETAG, "Cache-Control": "no-cache" },
        // Next.js gives API responses no Last-Modified to compare against.
        { "If-None-Match": HELLO_ETAG, "If-Modified-Since": "Wed, 21 Oct 2015 07:28:00 GMT" },
      ];
      for (const headers of staleRequests) {
        const response = await request.get(url, { headers });
        expect(response.status(), JSON.stringify(headers)).toBe(200);
        expect(response.headers()["etag"]).toBe(HELLO_ETAG);
        expect(await response.json()).toEqual({ message: "Hello from API!" });
      }
    });

    test("res.send(Buffer) sends its bytes under Next.js's Buffer ETag", async ({
      baseURL,
      request,
    }) => {
      const base = baseURL ?? fallbackBaseURL;
      const url = `${base}/api/send-buffer`;
      const first = await request.get(url);
      expect(first.status()).toBe(200);
      expect(first.headers()["etag"]).toBe(SEND_BUFFER_ETAG);
      expect([...(await first.body())]).toEqual([1, 2, 3]);

      const revalidated = await request.get(url, {
        headers: { "If-None-Match": SEND_BUFFER_ETAG },
      });
      expect(revalidated.status()).toBe(304);
      expect(await revalidated.body()).toHaveLength(0);
    });

    test("res.end() bodies get no generated ETag", async ({ baseURL, request }) => {
      const base = baseURL ?? fallbackBaseURL;
      const response = await request.get(`${base}/api/binary`);
      expect(response.status()).toBe(200);
      expect(response.headers()["etag"]).toBeUndefined();
    });
  });
}
