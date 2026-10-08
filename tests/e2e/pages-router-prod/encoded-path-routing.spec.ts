import { expect, test } from "@playwright/test";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

const PORT = 4175;

function getRawPath(
  path: string,
): Promise<{ body: string; headers: IncomingHttpHeaders; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: PORT }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          body,
          headers: res.headers,
          location: Array.isArray(res.headers.location)
            ? res.headers.location[0]
            : res.headers.location,
          status: res.statusCode ?? 0,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("keeps raw Pages route, middleware, slash, and header identity in production", async () => {
  const literal = await getRawPath("/about");
  expect(literal.status).toBe(200);
  expect(literal.headers["x-page-header"]).toBe("about-page");

  const alias = await getRawPath("/%61bout");
  expect(alias.status).toBe(404);
  expect(alias.body).not.toContain("About");
  expect(alias.headers["x-mw-pathname"]).toBe("/%61bout");
  expect(alias.headers["x-page-header"]).toBeUndefined();

  const slash = await getRawPath("/%61bout/");
  expect(slash.status).toBe(308);
  expect(slash.location).toBe("/%61bout");
});

test("canonicalizes WHATWG dot segments before Pages production routing and config", async () => {
  const page = await getRawPath("/%2e/about");
  expect(page.status).toBe(200);
  expect(page.headers["x-mw-pathname"]).toBe("/about");
  expect(page.headers["x-page-header"]).toBe("about-page");
  expect(page.body).toContain("About");

  const redirect = await getRawPath("/x/%2e%2e/old-about");
  expect(redirect.status).toBe(308);
  expect(redirect.location).toBe("/about");

  const rewrite = await getRawPath("/x/%2e%2e/before-rewrite");
  expect(rewrite.status).toBe(200);
  expect(rewrite.body).toContain("About");

  for (const escapedDelimiter of ["%2f", "%5c", "%252f"]) {
    expect((await getRawPath(`/x/${escapedDelimiter}/about`)).status).toBe(404);
  }
});

test("decodes Pages dynamic params exactly once in production", async () => {
  const encodedPercent = await getRawPath("/posts/a%2561");
  expect(encodedPercent.status).toBe(200);
  expect(encodedPercent.body).toMatch(/Post: (?:<!-- -->)?a%61/);

  const encodedSlash = await getRawPath("/posts/b%2Fc");
  expect(encodedSlash.status).toBe(200);
  expect(encodedSlash.body).toMatch(/Post: (?:<!-- -->)?b\/c/);
});

// Next.js 16.2.7 matches `/encoded-isr/%6Eew` to `[slug]`, which answers from
// the prerendered `getStaticProps` page cached under the decoded pathname.
test("renders an encoded getStaticProps page beside its dynamic sibling in production", async () => {
  const encoded = await getRawPath("/encoded-isr/%6Eew");
  expect(encoded.status).toBe(200);
  expect(encoded.body).toContain("static encoded-isr new");
  expect(encoded.body).not.toContain("dynamic encoded-isr");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const literal = await getRawPath("/encoded-isr/new");
    expect(literal.status).toBe(200);
    expect(literal.body).toContain("static encoded-isr new");
    expect(literal.body).not.toContain("dynamic encoded-isr");
  }
});

test("keeps an encoded dynamic render out of its sibling's ISR entry in production", async () => {
  // `[tab]` matches `/encoded-isr/bob/%73ettings` raw. Next.js 16.2.7 then
  // stores that render under `/encoded-isr/bob/settings` and serves it to the
  // literal `settings` page; vinext renders it without caching it.
  const encoded = await getRawPath("/encoded-isr/bob/%73ettings");
  expect(encoded.status).toBe(200);
  expect(encoded.body).toContain("tab settings for bob");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const literal = await getRawPath("/encoded-isr/bob/settings");
    expect(literal.status).toBe(200);
    expect(literal.body).toContain("settings for bob");
    expect(literal.body).not.toContain("tab settings");
  }
});

test("shares a dynamic Pages ISR entry with its encoded spelling in production", async () => {
  const encoded = await getRawPath("/encoded-isr/%62");
  expect(encoded.status).toBe(200);
  expect(encoded.body).toContain("dynamic encoded-isr b");

  const literal = await getRawPath("/encoded-isr/b");
  expect(literal.status).toBe(200);
  expect(literal.body).toContain("dynamic encoded-isr b");
  expect(literal.headers["x-vinext-cache"]).toBe("HIT");
});
