import { describe, expect, it } from "vite-plus/test";
import { toClientRedirects } from "../packages/vinext/src/client/client-redirects.js";
import { matchClientRedirect } from "../packages/vinext/src/client/client-redirect-matcher.js";
import type { RequestContext } from "../packages/vinext/src/config/config-matchers.js";

function browserContext(query = ""): RequestContext {
  return {
    cookies: { "internal-access": "cookie-secret-canary" },
    headers: new Headers({ "x-origin-auth": "header-secret-canary" }),
    host: "localhost",
    query: new URLSearchParams(query),
  };
}

const basePathState = { basePath: "", hadBasePath: true };

describe("client redirects", () => {
  it("publishes neither the conditions nor the destination of server-owned rules", () => {
    const redirects = toClientRedirects([
      {
        source: "/header",
        destination: "/header-target-canary",
        permanent: false,
        has: [{ type: "header", key: "x-origin-auth", value: "header-secret-canary" }],
      },
      {
        source: "/cookie",
        destination: "/cookie-target-canary",
        permanent: true,
        missing: [{ type: "cookie", key: "internal-access", value: "cookie-secret-canary" }],
      },
      {
        source: "/future",
        destination: "/future-target-canary",
        permanent: false,
        // A condition type the public type does not know yet stays server-owned.
        has: [{ type: "future" as "header", key: "k", value: "future-secret-canary" }],
      },
    ]);

    expect(redirects).toEqual([
      { source: "/header", requiresServerEvaluation: true },
      { source: "/cookie", requiresServerEvaluation: true },
      { source: "/future", requiresServerEvaluation: true },
    ]);
    expect(JSON.stringify(redirects)).not.toMatch(/canary|x-origin-auth|internal-access/);
  });

  it("keeps browser-authoritative conditions as a prefilter", () => {
    expect(
      toClientRedirects([
        {
          source: "/mixed",
          destination: "/secret-target",
          permanent: false,
          has: [
            { type: "query", key: "from", value: "nav" },
            { type: "header", key: "x-origin-auth", value: "header-secret-canary" },
          ],
          missing: [{ type: "host", key: "", value: "internal.example" }],
        },
        {
          source: "/plain",
          destination: "/about",
          permanent: true,
          has: [{ type: "query", key: "preview", value: "1" }],
          basePath: false,
        },
      ]),
    ).toEqual([
      {
        source: "/mixed",
        has: [{ type: "query", key: "from", value: "nav" }],
        missing: [{ type: "host", key: "", value: "internal.example" }],
        requiresServerEvaluation: true,
      },
      {
        source: "/plain",
        has: [{ type: "query", key: "preview", value: "1" }],
        destination: "/about",
        permanent: true,
        basePath: false,
      },
    ]);
  });

  it("does not let a later rule replace a matching server-owned rule", () => {
    const redirects = toClientRedirects([
      {
        source: "/docs/:slug",
        destination: "/beta/:slug",
        permanent: false,
        has: [
          { type: "query", key: "from", value: "nav" },
          { type: "cookie", key: "internal-access", value: "cookie-secret-canary" },
        ],
      },
      { source: "/docs/:slug", destination: "/v2/:slug", permanent: false },
    ]);

    expect(
      matchClientRedirect("/docs/intro", redirects, browserContext("from=nav"), basePathState),
    ).toBeNull();
    // The client-safe prefilter rules the server-owned rule out, so the later
    // rule is the one the server would apply too.
    expect(
      matchClientRedirect("/docs/intro", redirects, browserContext("from=link"), basePathState),
    ).toMatchObject({ destination: "/v2/intro", permanent: false });
  });
});
