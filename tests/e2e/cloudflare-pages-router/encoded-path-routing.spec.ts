import { expect, test } from "@playwright/test";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

const PORT = 4177;

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

test("keeps raw Pages route, middleware, slash, and header identity on Workers", async () => {
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

test("canonicalizes WHATWG dot segments before Pages Worker routing and config", async () => {
  const page = await getRawPath("/%2e/about");
  expect(page.status).toBe(200);
  expect(page.headers["x-mw-pathname"]).toBe("/about");
  expect(page.headers["x-page-header"]).toBe("about-page");
  expect(page.body).toContain("About");

  const redirect = await getRawPath("/x/%2e%2e/redirect-before-middleware-rewrite");
  expect(redirect.status).toBe(307);
  expect(redirect.location).toBe("/about");

  const rewrite = await getRawPath("/x/%2e%2e/rewrite-about");
  expect(rewrite.status).toBe(200);
  expect(rewrite.body).toContain("About");

  for (const escapedDelimiter of ["%2f", "%5c", "%252f"]) {
    expect((await getRawPath(`/x/${escapedDelimiter}/about`)).status).toBe(404);
  }
});

test("decodes Pages dynamic params exactly once on Workers", async () => {
  const encodedPercent = await getRawPath("/posts/a%2561");
  expect(encodedPercent.status).toBe(200);
  expect(encodedPercent.body).toMatch(/ID: (?:<!-- -->)?a%61/);

  const encodedSlash = await getRawPath("/posts/b%2Fc");
  expect(encodedSlash.status).toBe(200);
  expect(encodedSlash.body).toMatch(/ID: (?:<!-- -->)?b\/c/);
});

// Next.js 308s any raw path containing a backslash or a repeated slash to the
// collapsed path (base-server.ts / resolve-routes.ts); encoded leading
// delimiters stay a 404.
test("redirects repeated slashes and backslashes like Next.js on Workers", async () => {
  for (const [path, location] of [
    ["//", "/"],
    ["//?a=1", "/?a=1"],
    ["//evil.com", "/evil.com"],
    ["///evil.com", "/evil.com"],
    ["/\\evil.com", "/evil.com"],
    ["/about//", "/about/"],
  ] as const) {
    const response = await getRawPath(path);
    expect({ path, status: response.status, location: response.location }).toEqual({
      path,
      status: 308,
      location,
    });
  }
  for (const path of ["/%2F", "/%5C", "/%2F/evil.com", "/.//%2Fevil.com"]) {
    expect({ path, status: (await getRawPath(path)).status }).toEqual({ path, status: 404 });
  }
});

// Next.js 16.2.7 matches `/encoded-isr/%6Eew` to `[slug]`, which answers from
// the prerendered `getStaticProps` page cached under the decoded pathname.
test("renders an encoded getStaticProps page beside its dynamic sibling on Workers", async () => {
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

test("renders an encoded request-time page instead of its static sibling on Workers", async () => {
  // Without `getStaticProps`, Next.js has no cache entry to answer from, so
  // the raw-matched `getServerSideProps` page renders.
  const encoded = await getRawPath("/encoded-ssr/%6Eew");
  expect(encoded.status).toBe(200);
  expect(encoded.body).toContain("request-time encoded-ssr new");

  const literal = await getRawPath("/encoded-ssr/new");
  expect(literal.status).toBe(200);
  expect(literal.body).toContain("static encoded-ssr new");
});

test("renders an encoded preview request with its raw-matched page on Workers", async () => {
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

test("keeps an encoded dynamic render out of its sibling's ISR entry on Workers", async () => {
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

test("shares a dynamic Pages ISR entry with its encoded spelling on Workers", async () => {
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
