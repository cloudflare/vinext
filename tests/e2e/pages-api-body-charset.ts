import { expect, test } from "@playwright/test";

// Next.js parses Content-Type with the `content-type` package and decodes the
// body with its charset through iconv-lite 0.4 (UTF-8 by default), falling
// back to text/plain for a malformed header and answering 400 "Invalid body"
// for an unknown charset.
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
      // iconv-lite maps 0x80 to U+0080, where TextDecoder would give "€".
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x80]),
      "café\u0080",
    ],
    [
      "a CESU-8 JSON body",
      "application/json; charset=cesu-8",
      // CESU-8 encodes 😀 as its UTF-16 surrogate pair, three bytes each.
      Buffer.concat([
        Buffer.from('{"name":"café '),
        Buffer.from([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]),
        Buffer.from('"}'),
      ]),
      { name: "café 😀" },
    ],
    [
      "a UTF-7 JSON body",
      "application/json; charset=utf-7",
      Buffer.from('{"name":"+ZeVnLIqe-"}'),
      { name: "日本語" },
    ],
    [
      "a JSON body with a UTF-8 BOM",
      "application/json",
      Buffer.from('\ufeff{"name":"café"}'),
      { name: "café" },
    ],
    ["a text body that is only a UTF-8 BOM", "text/plain", Buffer.from([0xef, 0xbb, 0xbf]), ""],
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

  // raw-body checks the charset before the size limit (8 bytes on /api/parse-limited).
  for (const [name, path, charset] of [
    ["", "/api/parse", "unknown-charset"],
    [" before the size limit", "/api/parse-limited", "unknown-charset"],
    // iconv-lite finds "constructor" on Object.prototype and then fails to build it.
    [" named after an Object.prototype key", "/api/parse", "constructor"],
  ] as const) {
    test(`Pages API rejects an unknown body charset${name}`, async ({ baseURL, request }) => {
      const response = await request.post(`${baseURL ?? fallbackBaseURL}${path}`, {
        headers: { "content-type": `text/plain; charset=${charset}` },
        data: Buffer.from("more than eight bytes"),
      });
      expect(response.status()).toBe(400);
      expect(await response.text()).toBe("Invalid body");
    });
  }
}
