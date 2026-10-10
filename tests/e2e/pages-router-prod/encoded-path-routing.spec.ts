import { expect, test } from "@playwright/test";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

const PORT = 4175;

function getRawPath(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ body: string; headers: IncomingHttpHeaders; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ headers, host: "localhost", path, port: PORT }, (res) => {
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
  // The encoded request renders the page first, for its literal pathname.
  const encoded = await getRawPath("/encoded-isr/%6Eew");
  expect(encoded.status).toBe(200);
  expect(encoded.body).toContain("static encoded-isr new at /encoded-isr/new");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const literal = await getRawPath("/encoded-isr/new");
    expect(literal.status).toBe(200);
    expect(literal.body).toContain("static encoded-isr new at /encoded-isr/new");
  }
});

test("renders an encoded request-time page instead of its static sibling in production", async () => {
  // Without `getStaticProps`, Next.js has no cache entry to answer from, so
  // the raw-matched `getServerSideProps` page renders.
  const encoded = await getRawPath("/encoded-ssr/%6Eew");
  expect(encoded.status).toBe(200);
  expect(encoded.body).toContain("request-time encoded-ssr new");

  const literal = await getRawPath("/encoded-ssr/new");
  expect(literal.status).toBe(200);
  expect(literal.body).toContain("static encoded-ssr new");
});

test("renders an encoded preview request with its raw-matched page in production", async () => {
  // Draft mode has no cache entry to answer from, so the raw-matched
  // `getStaticProps` page renders, as in Next.js.
  const enabled = await getRawPath("/api/encoded-isr-preview");
  expect(enabled.status).toBe(200);
  const setCookie = enabled.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((value) => String(value).split(";")[0])
    .join("; ");
  expect(cookie).toContain("__prerender_bypass=");

  const encoded = await getRawPath("/encoded-isr/%6Eew", { cookie });
  expect(encoded.status).toBe(200);
  expect(encoded.body).toContain("dynamic encoded-isr new");
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
  // A fresh slug, so the HIT can only come from the encoded request's render.
  const slug = `b${Date.now().toString(36)}`;
  const encoded = await getRawPath(`/encoded-isr/%62${slug.slice(1)}`);
  expect(encoded.status).toBe(200);
  expect(encoded.body).toContain(`dynamic encoded-isr ${slug}`);

  const literal = await getRawPath(`/encoded-isr/${slug}`);
  expect(literal.status).toBe(200);
  expect(literal.body).toContain(`dynamic encoded-isr ${slug}`);
  expect(literal.headers["x-vinext-cache"]).toBe("HIT");
});

// Next.js builds each catch-all element separately, so `["value", "nested"]`
// is `/value/nested` and `["encoded/value"]` is `/encoded%2Fvalue`.
test("admits only listed catch-all elements for fallback false paths in production", async () => {
  const listed = await getRawPath("/catchall-optional/value/nested");
  expect(listed.status).toBe(200);
  expect(listed.body).toMatch(/Catch all: (?:<!-- -->)?\[(?:<!-- -->)?value, nested/);

  const listedSlash = await getRawPath("/catchall-optional/encoded%2Fvalue");
  expect(listedSlash.status).toBe(200);
  expect(listedSlash.body).toMatch(/Catch all: (?:<!-- -->)?\[(?:<!-- -->)?encoded\/value/);

  for (const path of ["/catchall-optional/value%2Fnested", "/catchall-optional/encoded/value"]) {
    const unlisted = await getRawPath(path);
    expect({ path, status: unlisted.status }).toEqual({ path, status: 404 });
    expect(unlisted.body).not.toContain("Catch all");
  }

  const buildId = listed.body.match(/"buildId":"([^"]+)"/)?.[1];
  expect(buildId).toBeTruthy();
  for (const path of ["value/nested", "encoded%2Fvalue"]) {
    const data = await getRawPath(`/_next/data/${buildId}/catchall-optional/${path}.json`);
    expect({ path, status: data.status }).toEqual({ path, status: 200 });
  }
  for (const path of ["value%2Fnested", "encoded/value"]) {
    const data = await getRawPath(`/_next/data/${buildId}/catchall-optional/${path}.json`);
    expect({ path, status: data.status, body: data.body }).toEqual({
      path,
      status: 404,
      body: '{"notFound":true}',
    });
  }
});
