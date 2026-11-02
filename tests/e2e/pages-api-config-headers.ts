import { expect, test, type APIResponse } from "@playwright/test";

function setCookies(response: APIResponse): string[] {
  return response
    .headersArray()
    .filter(({ name }) => name.toLowerCase() === "set-cookie")
    .map(({ value }) => value);
}

// Next.js writes the routing response headers to `res` before it invokes an API
// route, so the handler reads them and a header it sets replaces the routed one.
// A handler error answers on the same `res`, so the headers set so far are kept.
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/lib/router-server.ts
export function testPagesApiConfigHeaders(fallbackBaseURL?: string): void {
  test("Pages API handler reads and extends next.config headers", async ({ baseURL, request }) => {
    const response = await request.get(`${baseURL ?? fallbackBaseURL}/api/config-headers`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ link: '</sitemap.xml>; rel="sitemap"' });
    const headers = response.headers();
    expect(headers.link).toBe(
      '</sitemap.xml>; rel="sitemap", <https://example.com/doc>; rel="canonical"',
    );
    expect(headers["x-config-override"]).toBe("handler");
    expect(headers["x-config-untouched"]).toBe("config");
    expect(setCookies(response)).toEqual(["config-cookie=1; Path=/"]);
  });

  test("Pages API handler replaces a next.config Set-Cookie", async ({ baseURL, request }) => {
    const response = await request.get(
      `${baseURL ?? fallbackBaseURL}/api/config-headers?replace-cookie=1`,
    );
    expect(response.status()).toBe(200);
    expect(setCookies(response)).toEqual(["handler-cookie=1; Path=/"]);
    expect(response.headers()["x-config-untouched"]).toBe("config");
  });

  test("Pages API error keeps the headers the handler set before throwing", async ({
    baseURL,
    request,
  }) => {
    const response = await request.get(
      `${baseURL ?? fallbackBaseURL}/api/config-headers?replace-cookie=1&throw=1`,
    );
    expect(response.status()).toBe(500);
    const headers = response.headers();
    expect(headers.link).toBe(
      '</sitemap.xml>; rel="sitemap", <https://example.com/doc>; rel="canonical"',
    );
    expect(headers["x-config-override"]).toBe("handler");
    expect(headers["x-config-untouched"]).toBe("config");
    expect(setCookies(response)).toEqual(["handler-cookie=1; Path=/"]);
  });
}
