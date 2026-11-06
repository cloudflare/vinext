import { expect, test } from "@playwright/test";
import { getWithHost, startRewriteUpstream } from "../helpers";

// Next.js decides whether a middleware rewrite is external against its own
// hostname and port, so a Host header naming the rewrite target's host cannot
// make it internal and route the target path inside the app.
test("a Host header cannot turn an external middleware rewrite into an internal one", async ({
  baseURL,
}) => {
  const origin = baseURL ?? "http://localhost:4198";
  const upstream = await startRewriteUpstream();
  try {
    const attack = await getWithHost(origin, "/middleware-external-rewrite", upstream.host, {
      "x-middleware-test-rewrite-target": `http://${upstream.host}`,
    });
    expect({ status: attack.status, body: attack.body }).toEqual({
      status: 200,
      body: "external upstream",
    });
    expect(upstream.hits).toEqual(["/middleware-external-target"]);
  } finally {
    await upstream.close();
  }

  // Middleware's `new URL(path, request.url)` rewrites and redirects stay
  // same-origin for any public Host.
  const rewritten = await getWithHost(origin, "/middleware-rewrite-query", "public.example");
  expect(rewritten.status).toBe(200);
  expect(rewritten.body).toContain("from-rewrite");
  const redirected = await getWithHost(origin, "/middleware-redirect", "public.example");
  expect(redirected.status).toBe(307);
  expect(redirected.headers.location).toBe("/about");
});
