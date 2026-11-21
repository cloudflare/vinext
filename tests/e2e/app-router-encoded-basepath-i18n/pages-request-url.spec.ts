import { expect, test } from "@playwright/test";

// Observed against Next.js 16.2.7 (`next build --webpack && next start`) with
// basePath "/docs": a Pages Router page in an app with an app/ directory sees
// its URL without the basePath, removed once.
test("renders a hybrid Pages page with the basePath removed from req.url and asPath", async ({
  request,
}) => {
  const response = await request.get("/docs/docs/pages-request-url?x=1");
  expect(response.status()).toBe(200);
  const rendered = /<pre id="pages-request-url">([^<]*)<\/pre>/.exec(await response.text())?.[1];
  expect(JSON.parse(rendered?.replaceAll("&quot;", '"') ?? "null")).toEqual({
    asPath: "/docs/pages-request-url?x=1",
    reqUrl: "/docs/pages-request-url?x=1",
  });
});
