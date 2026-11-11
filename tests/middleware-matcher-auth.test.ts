import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/middleware-matcher-auth");
const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules",
);

const PROTECTED_PATHS = [
  "/",
  "/admin/secrets",
  "/dashboard/users",
  "/de",
  "/en/profile",
  "/docs",
  "/docs/en",
  "/docs/en/fr",
  "/manual/en",
  "/manual/en/fr",
  "/bar/secret",
  "/report.json",
  "/archive/2024-07-10",
  "/codes/ABCD",
  "/shared/abac",
  "/mixed/a1z9",
  "/shorthand/a1z9",
  "/bracket-shorthand/a1z9",
] as const;

const ENCODED_LINE_TERMINATORS = ["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"] as const;

async function assertAuthGuard(baseUrl: string): Promise<void> {
  const protectedResponses = await Promise.all(
    PROTECTED_PATHS.map(async (pathname) => {
      const response = await fetch(`${baseUrl}${pathname}`);
      return {
        pathname,
        status: response.status,
        guard: response.headers.get("x-auth-guard"),
        body: await response.text(),
      };
    }),
  );
  expect(protectedResponses.map(({ pathname, status }) => ({ pathname, status }))).toEqual(
    PROTECTED_PATHS.map((pathname) => ({ pathname, status: 403 })),
  );
  for (const { pathname, guard, body } of protectedResponses) {
    expect(guard, pathname).toBe("blocked");
    expect(body, pathname).toBe("blocked by middleware");
  }

  const publicResponse = await fetch(`${baseUrl}/public`);
  const publicBody = await publicResponse.text();
  expect(publicResponse.status, publicBody).toBe(200);
  expect(publicResponse.headers.get("x-auth-guard")).toBeNull();
  expect(publicBody).toContain("public page");

  const constrainedMiss = await fetch(`${baseUrl}/manual/de`);
  const constrainedMissBody = await constrainedMiss.text();
  expect(constrainedMiss.status, constrainedMissBody).toBe(200);
  expect(constrainedMiss.headers.get("x-auth-guard")).toBeNull();
  expect(constrainedMissBody).toContain("manual secret");

  const conditionedHeaders = {
    "x-present": "yes",
    cookie: "session=active",
  };
  const conditioned = await fetch(
    `${baseUrl}/conditioned?role=guest&role=admin&present=yes&present=&blocked=1&blocked=0`,
    { headers: conditionedHeaders },
  );
  expect(conditioned.status, await conditioned.text()).toBe(403);
  expect(conditioned.headers.get("x-auth-guard")).toBe("blocked");

  const wrongLastHas = await fetch(
    `${baseUrl}/conditioned?role=admin&role=guest&present=yes&present=&blocked=1&blocked=0`,
    { headers: conditionedHeaders },
  );
  const wrongLastHasBody = await wrongLastHas.text();
  expect(wrongLastHas.status, wrongLastHasBody).toBe(200);
  expect(wrongLastHas.headers.get("x-auth-guard")).toBeNull();
  expect(wrongLastHasBody).toContain("conditioned page");

  const wrongLastMissing = await fetch(
    `${baseUrl}/conditioned?role=guest&role=admin&present=yes&present=&blocked=0&blocked=1`,
    { headers: conditionedHeaders },
  );
  const wrongLastMissingBody = await wrongLastMissing.text();
  expect(wrongLastMissing.status, wrongLastMissingBody).toBe(200);
  expect(wrongLastMissing.headers.get("x-auth-guard")).toBeNull();
  expect(wrongLastMissingBody).toContain("conditioned page");
}

async function assertEncodedPathAuthGuard(baseUrl: string): Promise<void> {
  const headers = { "x-encoded-path-auth": "1" };
  const targets = [
    { body: "protected localized admin page", pathname: "/xx/admin/dashboard" },
    { body: "protected order page", pathname: "/orders/42" },
    { body: "protected invoice route handler", pathname: "/billing/invoices/current" },
    ...ENCODED_LINE_TERMINATORS.flatMap((encoded) => [
      { body: "protected localized admin page", pathname: `/xx${encoded}/admin/dashboard` },
      { body: "protected order page", pathname: `/orders/42${encoded}` },
      { body: "protected invoice route handler", pathname: `/billing/invoices/${encoded}` },
    ]),
  ];

  const unguardedResults: Array<{
    body: string;
    expectedBody: string;
    guard: string | null;
    pathname: string;
    status: number;
  }> = [];
  for (const target of targets) {
    const response = await fetch(`${baseUrl}${target.pathname}`);
    unguardedResults.push({
      body: await response.text(),
      expectedBody: target.body,
      guard: response.headers.get("x-auth-guard"),
      pathname: target.pathname,
      status: response.status,
    });
  }
  expect(unguardedResults.map(({ pathname, status }) => ({ pathname, status }))).toEqual(
    targets.map(({ pathname }) => ({ pathname, status: 200 })),
  );
  for (const { body, expectedBody, guard, pathname } of unguardedResults) {
    expect(guard, pathname).toBeNull();
    expect(body, pathname).toContain(expectedBody);
  }

  const results: Array<{ body: string; guard: string | null; pathname: string; status: number }> =
    [];
  for (const target of targets) {
    const response = await fetch(`${baseUrl}${target.pathname}`, { headers });
    results.push({
      body: await response.text(),
      guard: response.headers.get("x-auth-guard"),
      pathname: target.pathname,
      status: response.status,
    });
  }

  expect(results.map(({ pathname, status }) => ({ pathname, status }))).toEqual(
    targets.map(({ pathname }) => ({ pathname, status: 403 })),
  );
  for (const { body, guard, pathname } of results) {
    expect(guard, pathname).toBe("blocked");
    expect(body, pathname).toBe("blocked by middleware");
  }
}

async function assertEncodedDelimiterAuthGuard(baseUrl: string): Promise<void> {
  const protectedTargets = [
    { body: "protected order page", pathname: "/orders/42%2F" },
    { body: "protected order page", pathname: "/orders/42%3F" },
    { body: "protected order page", pathname: "/orders/42%23" },
    { body: "protected localized admin page", pathname: "/xx/admin/dash%2Fboard" },
    {
      body: "protected invoice route handler",
      pathname: "/billing/invoices/current%2Fq3",
    },
  ];
  const matcherMissPaths = ["/orders/42%5C", "/orders/42%252F", "/orders/42%20"];

  for (const target of protectedTargets) {
    const response = await fetch(`${baseUrl}${target.pathname}`);
    const body = await response.text();
    expect(response.status, target.pathname).toBe(200);
    expect(response.headers.get("x-auth-guard"), target.pathname).toBeNull();
    expect(body, target.pathname).toContain(target.body);
  }
  for (const pathname of matcherMissPaths) {
    const response = await fetch(`${baseUrl}${pathname}`);
    const body = await response.text();
    expect(response.status, pathname).toBe(200);
    expect(response.headers.get("x-auth-guard"), pathname).toBeNull();
    expect(body, pathname).toContain("protected order page");
  }

  const headers = { "x-encoded-delimiter-auth": "1" };
  for (const target of protectedTargets) {
    const response = await fetch(`${baseUrl}${target.pathname}`, { headers });
    const body = await response.text();
    expect(response.status, target.pathname).toBe(403);
    expect(response.headers.get("x-auth-guard"), target.pathname).toBe("blocked");
    expect(body, target.pathname).toBe("blocked by middleware");
  }
  for (const pathname of matcherMissPaths) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    const body = await response.text();
    expect(response.status, pathname).toBe(200);
    expect(response.headers.get("x-auth-guard"), pathname).toBeNull();
    expect(body, pathname).toContain("protected order page");
  }
}

async function assertRscSuffixAuthGuard(baseUrl: string): Promise<void> {
  const headers = { "x-rsc-dot-segment-auth": "1" };
  // As in Next.js, a `.rsc` suffix is an ordinary part of the last segment, so
  // none of these can leave a `.` or `..` segment the matcher does not cover.
  const guardedPaths = [
    "/xx/admin/dashboard.rsc",
    "/xx/admin/....rsc",
    "/xx/admin/...rsc",
    "/xx/admin/..rsc",
    "/xx/admin/%2E%2E.rsc",
    "/xx/admin/.%2e.rsc",
    "/billing/invoices/current.rsc",
    "/billing/invoices/...rsc",
  ];

  for (const pathname of guardedPaths) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    const body = await response.text();
    expect(response.status, pathname).toBe(403);
    expect(response.headers.get("x-auth-guard"), pathname).toBe("blocked");
    expect(body, pathname).toBe("blocked by middleware");
  }
}

async function assertMetadataRouteSuffixAuthGuard(baseUrl: string): Promise<void> {
  // Next.js runs middleware for every spelling of an exact metadata route
  // matcher. A `.rsc` suffix, encoded or not, never selects the metadata route,
  // so the suffixed spellings 404 instead of serving it.
  const targets = [
    { body: "protected-sitemap-entry", pathname: "/sitemap.xml" },
    { body: "protected-robots-entry", pathname: "/robots.txt" },
  ];
  const suffixes = [".rsc", "%2Ersc", "%2ersc", ".rs%63"];

  for (const target of targets) {
    const response = await fetch(`${baseUrl}${target.pathname}`);
    const body = await response.text();
    expect(response.status, target.pathname).toBe(200);
    expect(response.headers.get("x-auth-guard"), target.pathname).toBeNull();
    expect(body, target.pathname).toContain(target.body);
  }
  for (const target of targets) {
    for (const suffix of suffixes) {
      const pathname = `${target.pathname}${suffix}`;
      const response = await fetch(`${baseUrl}${pathname}`);
      const body = await response.text();
      expect(response.status, pathname).toBe(404);
      expect(response.headers.get("x-auth-guard"), pathname).toBeNull();
      expect(body, pathname).not.toContain(target.body);
    }
  }

  const headers = { "x-metadata-route-auth": "1" };
  const guardedPaths = [
    ...targets.flatMap(({ pathname }) => [
      pathname,
      ...suffixes.map((suffix) => `${pathname}${suffix}`),
    ]),
    "/sitemap.xm%6C",
    "/robots.tx%74",
  ];
  for (const pathname of guardedPaths) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    const body = await response.text();
    expect(response.status, pathname).toBe(403);
    expect(response.headers.get("x-auth-guard"), pathname).toBe("blocked");
    expect(body, pathname).toBe("blocked by middleware");
  }
}

async function assertStaticAssetExclusionAuthGuard(baseUrl: string): Promise<void> {
  const headers = { "x-static-asset-auth": "1" };
  // `js(?!on)` excludes `.js` but not `.json`, and `.cs` is not `.css`/`.csv`.
  const guardedPaths = ["/public", "/public.json", "/public.cs"];
  const excludedPaths = [
    "/public.htm",
    "/public.html",
    "/public.js",
    "/public.jpg",
    "/public.jpeg",
    "/public.woff",
    "/public.woff2",
    "/public.docx",
  ];

  for (const pathname of guardedPaths) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    const body = await response.text();
    expect(response.status, pathname).toBe(403);
    expect(response.headers.get("x-auth-guard"), pathname).toBe("blocked");
    expect(body, pathname).toBe("blocked by middleware");
  }
  for (const pathname of excludedPaths) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    await response.body?.cancel();
    expect(response.status, pathname).not.toBe(403);
    expect(response.headers.get("x-auth-guard"), pathname).toBeNull();
  }
}

async function assertHybridPagesEncodedAliasAuthGuard(baseUrl: string): Promise<void> {
  // Middleware and Next.js' filesystem lookup each test the raw pathname and at
  // most one decode of it. Routing a Pages page or API route in a hybrid
  // App+Pages app must not decode a `%25xx` alias a second time into a route
  // that middleware never matched.
  const headers = { "x-hybrid-pages-auth": "1" };
  const targets = [
    { body: "protected pages staff panel", pathname: "/staff/panel" },
    { body: "protected pages staff api", pathname: "/api/staff/users" },
  ];
  const guardedAliasPaths = ["/%73taff/panel", "/api/%73taff/users", "/api/staff/%2575sers"];
  const aliasPaths = ["/%2573taff/panel", "/api/%2573taff/users"];

  for (const target of targets) {
    const response = await fetch(`${baseUrl}${target.pathname}`);
    const body = await response.text();
    expect(response.status, target.pathname).toBe(200);
    expect(response.headers.get("x-auth-guard"), target.pathname).toBeNull();
    expect(body, target.pathname).toContain(target.body);
  }
  for (const pathname of [...targets.map((target) => target.pathname), ...guardedAliasPaths]) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    const body = await response.text();
    expect(response.status, pathname).toBe(403);
    expect(response.headers.get("x-auth-guard"), pathname).toBe("blocked");
    expect(body, pathname).toBe("blocked by middleware");
  }
  for (const pathname of aliasPaths) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    const body = await response.text();
    expect(response.status, pathname).toBe(404);
    expect(response.headers.get("x-auth-guard"), pathname).toBeNull();
    expect(body, pathname).not.toContain("protected pages staff");
  }
}

async function assertHybridPagesEncodedDataAliasAuthGuard(baseUrl: string): Promise<void> {
  // `_next/data` requests reach the same hybrid Pages routing, so a `%25xx`
  // alias must not decode twice into the page's props.
  const page = await fetch(`${baseUrl}/staff/panel`);
  const html = await page.text();
  expect(page.status, html).toBe(200);
  const buildId = /"buildId":"([^"]+)"/.exec(html)?.[1];
  expect(buildId).toBeTruthy();
  const dataHeaders = { "x-nextjs-data": "1" };
  const guardHeaders = { "x-hybrid-pages-auth": "1" };
  const dataPath = (pathname: string) => `/_next/data/${buildId}${pathname}.json`;

  const data = await fetch(`${baseUrl}${dataPath("/staff/panel")}`, { headers: dataHeaders });
  const dataBody = await data.text();
  expect(data.status, dataBody).toBe(200);
  expect(data.headers.get("x-auth-guard")).toBeNull();
  expect(dataBody).toContain("protected pages staff props");

  const guarded = [
    { headers: { ...guardHeaders, ...dataHeaders }, pathname: dataPath("/staff/panel") },
    { headers: { ...guardHeaders, ...dataHeaders }, pathname: dataPath("/%73taff/panel") },
  ];
  for (const { headers, pathname } of guarded) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    const body = await response.text();
    expect(response.status, pathname).toBe(403);
    expect(response.headers.get("x-auth-guard"), pathname).toBe("blocked");
    expect(body, pathname).toBe("blocked by middleware");
  }

  // Next.js answers 404 here. vinext answers an unmatched hybrid `_next/data`
  // URL with `200 {}`, so only the missing page props and middleware header
  // are asserted.
  const aliasPath = dataPath("/%2573taff/panel");
  const alias = await fetch(`${baseUrl}${aliasPath}`, {
    headers: { ...guardHeaders, ...dataHeaders },
  });
  const aliasBody = await alias.text();
  expect(alias.headers.get("x-auth-guard"), aliasPath).toBeNull();
  expect(aliasBody, aliasPath).not.toContain("protected pages staff");
}

async function assertCaseSensitiveMatcherAuthGuard(baseUrl: string): Promise<void> {
  // Next.js compiles matchers case-sensitively, so exclusions such as `api` or
  // `js(?!on)` must not skip middleware for case variants that still route.
  const guardedTargets = [
    { header: "x-encoded-path-auth", pathname: "/API/admin/dashboard" },
    { header: "x-encoded-path-auth", pathname: "/Api/admin/dashboard" },
    { header: "x-encoded-path-auth", pathname: "/_NEXT/admin/dashboard" },
    { header: "x-encoded-path-auth", pathname: "/FAVICON.ICO" },
    { header: "x-static-asset-auth", pathname: "/public.JS" },
    { header: "x-static-asset-auth", pathname: "/public.HTML" },
  ];
  for (const { header, pathname } of guardedTargets) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers: { [header]: "1" } });
    const body = await response.text();
    expect(response.status, pathname).toBe(403);
    expect(response.headers.get("x-auth-guard"), pathname).toBe("blocked");
    expect(body, pathname).toBe("blocked by middleware");
  }

  // Case variants of included paths miss the matcher, as in Next.js. The
  // router is case-sensitive too, so they never reach the guarded routes.
  const codes = await fetch(`${baseUrl}/codes/abcd`);
  const codesBody = await codes.text();
  expect(codes.status, codesBody).toBe(200);
  expect(codes.headers.get("x-auth-guard")).toBeNull();
  expect(codesBody).toContain("codes secret");

  const missTargets: Array<{ headers: Record<string, string>; pathname: string }> = [
    { headers: {}, pathname: "/Admin/secrets" },
    { headers: { "x-hybrid-pages-auth": "1" }, pathname: "/Staff/panel" },
  ];
  for (const { headers, pathname } of missTargets) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    const body = await response.text();
    expect(response.status, pathname).toBe(404);
    expect(response.headers.get("x-auth-guard"), pathname).toBeNull();
    expect(body, pathname).not.toMatch(/admin secret|protected pages staff/);
  }
}

async function closeHttpServer(server: http.Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("valid middleware matcher auth guards", () => {
  describe("development server", () => {
    let root = "";
    let server: ViteDevServer | undefined;
    let baseUrl = "";

    beforeAll(async () => {
      root = await createIsolatedFixture(
        FIXTURE_DIR,
        "vinext-middleware-matcher-dev-",
        (source) => path.basename(source) !== "wrangler.jsonc",
      );
      ({ server, baseUrl } = await startFixtureServer(root));
    }, 30_000);

    afterAll(async () => {
      await server?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("blocks every path selected by group and constrained-repeat matchers", async () => {
      await assertAuthGuard(baseUrl);
    }, 30_000);

    it("keeps encoded line terminators inside middleware auth scope", async () => {
      await assertEncodedPathAuthGuard(baseUrl);
    }, 30_000);

    it("matches decoded path delimiters with constrained matcher parity", async () => {
      await assertEncodedDelimiterAuthGuard(baseUrl);
    }, 30_000);

    it("skips extensions excluded by bounded optional matcher branches", async () => {
      await assertStaticAssetExclusionAuthGuard(baseUrl);
    }, 30_000);

    it("treats a `.rsc` suffix as an ordinary path segment", async () => {
      await assertRscSuffixAuthGuard(baseUrl);
    }, 30_000);

    it("runs middleware for encoded `.rsc` spellings of metadata routes", async () => {
      await assertMetadataRouteSuffixAuthGuard(baseUrl);
    }, 30_000);

    it("keeps double-encoded aliases out of hybrid Pages routes", async () => {
      await assertHybridPagesEncodedAliasAuthGuard(baseUrl);
    }, 30_000);

    it("keeps double-encoded aliases out of hybrid Pages data requests", async () => {
      await assertHybridPagesEncodedDataAliasAuthGuard(baseUrl);
    }, 30_000);

    it("matches middleware paths case-sensitively", async () => {
      await assertCaseSensitiveMatcherAuthGuard(baseUrl);
    }, 30_000);
  });

  describe("built Node production server", () => {
    let root = "";
    let server: http.Server | undefined;
    let baseUrl = "";

    beforeAll(async () => {
      root = await createIsolatedFixture(
        FIXTURE_DIR,
        "vinext-middleware-matcher-node-",
        (source) => path.basename(source) !== "wrangler.jsonc",
      );
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [vinext({ appDir: root })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      const started = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir: path.join(root, "dist"),
        noCompression: true,
      });
      server = started.server;
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Middleware matcher Node fixture did not bind to a port");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
    }, 120_000);

    afterAll(async () => {
      await closeHttpServer(server);
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("blocks every path selected by group and constrained-repeat matchers", async () => {
      await assertAuthGuard(baseUrl);
    });

    it("keeps encoded line terminators inside middleware auth scope", async () => {
      await assertEncodedPathAuthGuard(baseUrl);
    });

    it("matches decoded path delimiters with constrained matcher parity", async () => {
      await assertEncodedDelimiterAuthGuard(baseUrl);
    });

    it("skips extensions excluded by bounded optional matcher branches", async () => {
      await assertStaticAssetExclusionAuthGuard(baseUrl);
    });

    it("treats a `.rsc` suffix as an ordinary path segment", async () => {
      await assertRscSuffixAuthGuard(baseUrl);
    });

    it("runs middleware for encoded `.rsc` spellings of metadata routes", async () => {
      await assertMetadataRouteSuffixAuthGuard(baseUrl);
    });

    it("keeps double-encoded aliases out of hybrid Pages routes", async () => {
      await assertHybridPagesEncodedAliasAuthGuard(baseUrl);
    });

    it("keeps double-encoded aliases out of hybrid Pages data requests", async () => {
      await assertHybridPagesEncodedDataAliasAuthGuard(baseUrl);
    });

    it("matches middleware paths case-sensitively", async () => {
      await assertCaseSensitiveMatcherAuthGuard(baseUrl);
    });
  });

  describe("built Cloudflare Worker", () => {
    let root = "";
    let worker: { url: Promise<URL>; dispose(): Promise<void> } | undefined;
    let baseUrl = "";

    beforeAll(async () => {
      root = await createIsolatedFixture(
        FIXTURE_DIR,
        "vinext-middleware-matcher-worker-",
        undefined,
        CLOUDFLARE_NODE_MODULES,
      );
      const cloudflarePluginPath = path.join(
        root,
        "node_modules/@cloudflare/vite-plugin/dist/index.mjs",
      );
      const { cloudflare } = (await import(pathToFileURL(cloudflarePluginPath).href)) as {
        cloudflare: (options: {
          viteEnvironment: { name: string; childEnvironments: string[] };
        }) => import("vite").Plugin;
      };
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [
          vinext({ appDir: root }),
          cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
        ],
        logLevel: "silent",
      });
      await builder.buildApp();

      const wranglerPath = path.join(root, "node_modules/wrangler/wrangler-dist/cli.js");
      const wrangler = (await import(pathToFileURL(wranglerPath).href)) as {
        unstable_startWorker(options: {
          config: string;
          dev: {
            remote: false;
            persist: false;
            logLevel: "none";
            watch: false;
            server: { hostname: string; port: 0 };
          };
        }): Promise<{ url: Promise<URL>; dispose(): Promise<void> }>;
      };
      worker = await wrangler.unstable_startWorker({
        config: path.join(root, "dist/server/wrangler.json"),
        dev: {
          remote: false,
          persist: false,
          logLevel: "none",
          watch: false,
          server: { hostname: "127.0.0.1", port: 0 },
        },
      });
      await worker.url;
      baseUrl = (await worker.url).origin;
    }, 180_000);

    afterAll(async () => {
      await worker?.dispose();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("blocks every path selected by group and constrained-repeat matchers", async () => {
      await assertAuthGuard(baseUrl);
    });

    it("keeps encoded line terminators inside middleware auth scope", async () => {
      await assertEncodedPathAuthGuard(baseUrl);
    });

    it("matches decoded path delimiters with constrained matcher parity", async () => {
      await assertEncodedDelimiterAuthGuard(baseUrl);
    });

    it("skips extensions excluded by bounded optional matcher branches", async () => {
      await assertStaticAssetExclusionAuthGuard(baseUrl);
    });

    it("treats a `.rsc` suffix as an ordinary path segment", async () => {
      await assertRscSuffixAuthGuard(baseUrl);
    });

    it("runs middleware for encoded `.rsc` spellings of metadata routes", async () => {
      await assertMetadataRouteSuffixAuthGuard(baseUrl);
    });

    it("keeps double-encoded aliases out of hybrid Pages routes", async () => {
      await assertHybridPagesEncodedAliasAuthGuard(baseUrl);
    });

    it("keeps double-encoded aliases out of hybrid Pages data requests", async () => {
      await assertHybridPagesEncodedDataAliasAuthGuard(baseUrl);
    });

    it("matches middleware paths case-sensitively", async () => {
      await assertCaseSensitiveMatcherAuthGuard(baseUrl);
    });
  });
});

describe("invalid middleware matcher object auth guards", () => {
  it("rejects an object matcher with an unsupported field before production build", async () => {
    const root = await createIsolatedFixture(
      FIXTURE_DIR,
      "vinext-middleware-matcher-invalid-object-",
      (source) => path.basename(source) !== "wrangler.jsonc",
    );
    try {
      await fs.writeFile(
        path.join(root, "middleware.ts"),
        `export function middleware() {
  return new Response("blocked by middleware", {
    status: 403,
    headers: { "x-auth-guard": "blocked" },
  })
}
export const config = {
  matcher: [{ source: "/admin/:path*", typo: true }],
}
`,
      );

      await expect(
        createBuilder({
          root,
          configFile: false,
          plugins: [vinext({ appDir: root })],
          logLevel: "silent",
        }),
      ).rejects.toThrow(/matcher object contains unsupported field "typo"/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
