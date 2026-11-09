import { expect, test } from "@playwright/test";
import { getWithHost, startRewriteUpstream } from "../helpers";

// Next.js builds the middleware URL from its own hostname, so the Host header
// never changes the pathname middleware matches.
test("a Host header cannot move the request path away from Pages middleware", async ({
  baseURL,
}) => {
  const origin = baseURL ?? "http://localhost:4175";
  const { host } = new URL(origin);

  for (const hostHeader of [
    host,
    `${host}?`,
    `${host}#`,
    `${host}/api?`,
    `${host}/zzz#`,
    `${host}\\zzz`,
  ]) {
    const blocked = await getWithHost(origin, "/middleware-protected-data", hostHeader);
    expect({ hostHeader, status: blocked.status, body: blocked.body }).toEqual({
      hostHeader,
      status: 403,
      body: "Access Denied",
    });

    // A beforeFiles rewrite source must pass middleware on the same pathname.
    const rewritten = await getWithHost(origin, "/before-rewrite", hostHeader);
    expect({ hostHeader, status: rewritten.status }).toEqual({ hostHeader, status: 200 });
    expect(rewritten.headers["x-mw-pathname"]).toBe("/before-rewrite");
    expect(rewritten.body).toContain("About");
  }
});

// Next.js decides whether a middleware rewrite is external against its own
// hostname and port, so a Host header naming the rewrite target's host cannot
// make it internal and render the local page middleware protects.
test("a Host header cannot turn an external middleware rewrite into an internal one", async ({
  baseURL,
}) => {
  const origin = baseURL ?? "http://localhost:4175";
  const upstream = await startRewriteUpstream();
  try {
    const attack = await getWithHost(origin, "/data-external-rewrite", upstream.host, {
      "x-middleware-test-rewrite-target": `http://${upstream.host}/middleware-protected-data`,
    });
    expect(attack.body).not.toContain("only visible after middleware");
    expect({ status: attack.status, body: attack.body }).toEqual({
      status: 200,
      body: "external upstream",
    });
    expect(upstream.hits).toEqual(["/middleware-protected-data"]);
  } finally {
    await upstream.close();
  }

  // Middleware's `new URL(path, request.url)` rewrites and redirects stay
  // same-origin for any public Host.
  const rewritten = await getWithHost(origin, "/rewritten", "public.example");
  expect(rewritten.status).toBe(200);
  const redirected = await getWithHost(origin, "/old-page", "public.example");
  expect(redirected.status).toBe(307);
  expect(redirected.headers.location).toBe("/about");
});
