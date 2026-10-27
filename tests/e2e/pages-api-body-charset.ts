import { expect, test } from "@playwright/test";

// Next.js parses Content-Type with the `content-type` package and decodes the
// body with its charset (UTF-8 by default), falling back to text/plain for a
// malformed header and answering 400 "Invalid body" for an unknown charset.
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/api-utils/node/parse-body.ts
export function testPagesApiBodyCharsets(fallbackBaseURL?: string): void {
  const cases: Array<[name: string, contentType: string, body: Buffer, expected: unknown]> = [
    [
      "a UTF-16LE JSON body",
      "application/json; charset=utf-16le",
      Buffer.from('{"name":"café 😀"}', "utf16le"),
      { name: "café 😀" },
    ],
    [
      "a quoted Latin-1 charset",
      'text/plain; Charset="ISO-8859-1"',
      Buffer.from("café", "latin1"),
      "café",
    ],
    [
      "a JSON body with a UTF-8 BOM",
      "application/json",
      Buffer.from('\ufeff{"name":"café"}'),
      { name: "café" },
    ],
    [
      "a malformed Content-Type as text",
      "application/json; charset",
      Buffer.from('{"name":"café"}'),
      '{"name":"café"}',
    ],
  ];
  for (const [name, contentType, body, expected] of cases) {
    test(`Pages API decodes ${name}`, async ({ baseURL, request }) => {
      const response = await request.post(`${baseURL ?? fallbackBaseURL}/api/parse`, {
        headers: { "content-type": contentType },
        data: body,
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual(expected);
    });
  }
}

// These responses leave the request body unread, which makes `wrangler dev`
// exit (https://github.com/cloudflare/workers-sdk/issues/15203), so the
// Cloudflare suite doesn't run them.
export function testPagesApiBodyCharsetRejections(fallbackBaseURL?: string): void {
  // raw-body checks the charset before the size limit (8 bytes on /api/parse-limited).
  for (const [name, path] of [
    ["", "/api/parse"],
    [" before the size limit", "/api/parse-limited"],
  ] as const) {
    test(`Pages API rejects an unknown body charset${name}`, async ({ baseURL, request }) => {
      const response = await request.post(`${baseURL ?? fallbackBaseURL}${path}`, {
        headers: { "content-type": "text/plain; charset=unknown-charset" },
        data: Buffer.from("more than eight bytes"),
      });
      expect(response.status()).toBe(400);
      expect(await response.text()).toBe("Invalid body");
    });
  }
}
