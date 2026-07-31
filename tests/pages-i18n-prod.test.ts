import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { build } from "vite-plus";
import path from "node:path";
import fsp from "node:fs/promises";
import http from "node:http";
import vinext from "../packages/vinext/src/index.js";
import {
  PAGES_I18N_DOMAINS_BASEPATH_FIXTURE_DIR,
  PAGES_I18N_DOMAINS_FIXTURE_DIR,
  createIsolatedFixture,
  requestNodeServerWithHost,
} from "./helpers.js";

const TEST_REVALIDATE_SECRET = "22".repeat(32);

async function startProdFixture(
  fixtureDir: string,
  prefix: string,
): Promise<{
  port: number;
  server: http.Server;
  tmpDir: string;
}> {
  const tmpDir = await createIsolatedFixture(fixtureDir, prefix);
  const outDir = path.join(tmpDir, "dist");
  const previousRevalidateSecret = process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
  process.env.__VINEXT_SHARED_REVALIDATE_SECRET = TEST_REVALIDATE_SECRET;
  // Pages Router only — no RSC pipeline, so separate build() calls work.
  // For App Router, use createBuilder().buildApp() instead.
  try {
    await build({
      root: tmpDir,
      configFile: false,
      plugins: [vinext()],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
    });
    await build({
      root: tmpDir,
      configFile: false,
      plugins: [vinext()],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "client"),
        manifest: true,
        ssrManifest: true,
        rolldownOptions: { input: "virtual:vinext-client-entry" },
      },
    });
  } finally {
    if (previousRevalidateSecret === undefined) {
      delete process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
    } else {
      process.env.__VINEXT_SHARED_REVALIDATE_SECRET = previousRevalidateSecret;
    }
  }

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir,
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error(`Failed to start production server for fixture ${fixtureDir}`);
  }

  return { port: addr.port, server, tmpDir };
}

describe("Pages i18n domain routing (production)", () => {
  let tmpDir: string;
  let prodServer: http.Server;
  let prodPort: number;

  beforeAll(async () => {
    ({
      server: prodServer,
      tmpDir,
      port: prodPort,
    } = await startProdFixture(PAGES_I18N_DOMAINS_FIXTURE_DIR, "vinext-pages-i18n-prod-"));
  }, 30000);

  afterAll(async () => {
    if (prodServer) {
      await new Promise<void>((resolve) => prodServer.close(() => resolve()));
    }
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }, 15000);

  it("redirects the root path to the preferred locale domain", async () => {
    const res = await requestNodeServerWithHost(prodPort, "/", "example.com", {
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    });

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe("http://example.fr/");
  });

  it("uses Accept-Language rather than NEXT_LOCALE to pick the preferred domain", async () => {
    const res = await requestNodeServerWithHost(prodPort, "/", "example.com", {
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      Cookie: "NEXT_LOCALE=en",
    });

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe("http://example.fr/");
  });

  it("preserves the search string on root locale redirects", async () => {
    const res = await requestNodeServerWithHost(
      prodPort,
      "/?utm=campaign&next=%2Fcheckout",
      "example.com",
      {
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
    );

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe("http://example.fr/?utm=campaign&next=%2Fcheckout");
  });

  it("does not redirect unprefixed non-root paths for locale detection", async () => {
    const res = await requestNodeServerWithHost(prodPort, "/about", "example.com", {
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    });

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
  });

  it("renders locale-switcher links with the target locale domain during SSR", async () => {
    const res = await requestNodeServerWithHost(prodPort, "/about", "example.com");

    expect(res.status).toBe(200);
    expect(res.body).toContain('href="http://example.fr/about" id="switch-locale"');
  });

  it("uses the matched domain default locale for request context", async () => {
    const res = await requestNodeServerWithHost(prodPort, "/about", "example.fr");

    expect(res.status).toBe(200);
    expect(res.body).toContain('<p id="locale">fr</p>');
    expect(res.body).toContain('<p id="defaultLocale">fr</p>');
    expect(res.body).toContain('href="/about" id="switch-locale"');
    expect(res.body).toContain('"defaultLocale":"fr"');
    expect(res.body).toContain(
      '"domainLocales":[{"domain":"example.com","defaultLocale":"en"},{"domain":"example.fr","defaultLocale":"fr","http":true}]',
    );
  });

  it("keys Pages ISR entries by i18n domain context", async () => {
    const fr = await requestNodeServerWithHost(prodPort, "/isr-about", "example.fr");
    expect(fr.status).toBe(200);
    expect(fr.headers["x-vinext-cache"]).toBe("MISS");
    expect(fr.body).toContain('<p id="locale">fr</p>');
    expect(fr.body).toContain('<p id="defaultLocale">fr</p>');

    const en = await requestNodeServerWithHost(prodPort, "/isr-about", "example.com");
    expect(en.status).toBe(200);
    expect(en.headers["x-vinext-cache"]).toBe("MISS");
    expect(en.body).toContain('<p id="locale">en</p>');
    expect(en.body).toContain('<p id="defaultLocale">en</p>');
    expect(en.body).not.toContain('<p id="locale">fr</p>');

    const enHit = await requestNodeServerWithHost(prodPort, "/isr-about", "example.com");
    expect(enHit.status).toBe(200);
    expect(enHit.headers["x-vinext-cache"]).toBe("HIT");
    expect(enHit.body).toContain('<p id="locale">en</p>');
  });

  it("revalidates the ISR entry owned by the request domain", async () => {
    const before = await requestNodeServerWithHost(prodPort, "/isr-about", "example.fr");
    const beforeRenderedAt = before.body.match(/<p id="renderedAt">([^<]+)<\/p>/)?.[1];
    const beforeEn = await requestNodeServerWithHost(prodPort, "/isr-about", "example.com");
    const beforeEnRenderedAt = beforeEn.body.match(/<p id="renderedAt">([^<]+)<\/p>/)?.[1];

    const revalidate = await requestNodeServerWithHost(
      prodPort,
      "/api/revalidate?path=%2Fisr-about",
      "example.fr",
    );
    expect(revalidate.status).toBe(200);
    expect(JSON.parse(revalidate.body)).toEqual({ revalidated: true });

    const after = await requestNodeServerWithHost(prodPort, "/isr-about", "example.fr");
    expect(after.body).toContain('<p id="locale">fr</p>');
    expect(after.body.match(/<p id="renderedAt">([^<]+)<\/p>/)?.[1]).not.toBe(beforeRenderedAt);
    const afterEn = await requestNodeServerWithHost(prodPort, "/isr-about", "example.com");
    expect(afterEn.body.match(/<p id="renderedAt">([^<]+)<\/p>/)?.[1]).toBe(beforeEnRenderedAt);
  });

  it("authenticates and strips the logical-host side channel", async () => {
    const forged = await requestNodeServerWithHost(
      prodPort,
      "/api/revalidation-headers",
      "example.com",
      {
        "x-prerender-revalidate": "not-the-secret",
        "x-vinext-revalidate-host": "example.fr",
      },
    );
    expect(JSON.parse(forged.body)).toEqual({ host: "example.com", logicalHost: null });

    const unconfigured = await requestNodeServerWithHost(
      prodPort,
      "/api/revalidation-headers",
      "example.com",
      {
        "x-prerender-revalidate": TEST_REVALIDATE_SECRET,
        "x-vinext-revalidate-host": "attacker.example",
      },
    );
    expect(JSON.parse(unconfigured.body)).toEqual({ host: "example.com", logicalHost: null });

    const trusted = await requestNodeServerWithHost(
      prodPort,
      "/api/revalidation-headers",
      "127.0.0.1",
      {
        "x-prerender-revalidate": TEST_REVALIDATE_SECRET,
        "x-vinext-revalidate-host": "example.fr",
      },
    );
    expect(JSON.parse(trusted.body)).toEqual({ host: "example.fr", logicalHost: null });
  });

  // Issue #1336 item 3: locale prefix must be stripped before API route matching.
  //
  // Ported from Next.js: test/e2e/middleware-redirects/test/index.test.ts
  // (the "should redirect to api route with locale" case, which exercises
  // /fr/api/ok hitting pages/api/ok.js)
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-redirects/test/index.test.ts
  it("matches /api/ok without a locale prefix", async () => {
    const res = await requestNodeServerWithHost(prodPort, "/api/ok", "example.com");

    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("matches /fr/api/ok by stripping the locale prefix (issue #1336)", async () => {
    const res = await requestNodeServerWithHost(prodPort, "/fr/api/ok", "example.com");

    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("preserves query parameters when stripping the locale prefix from an API path", async () => {
    const res = await requestNodeServerWithHost(
      prodPort,
      "/fr/api/ok?foo=bar&baz=qux",
      "example.com",
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });
});

describe("Pages i18n domain routing with basePath (production)", () => {
  let tmpDir: string;
  let prodServer: http.Server;
  let prodPort: number;

  beforeAll(async () => {
    ({
      server: prodServer,
      tmpDir,
      port: prodPort,
    } = await startProdFixture(
      PAGES_I18N_DOMAINS_BASEPATH_FIXTURE_DIR,
      "vinext-pages-i18n-basepath-prod-",
    ));
  }, 30000);

  afterAll(async () => {
    if (prodServer) {
      await new Promise<void>((resolve) => prodServer.close(() => resolve()));
    }
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }, 15000);

  it("preserves basePath and trailingSlash in root locale redirects", async () => {
    const res = await requestNodeServerWithHost(prodPort, "/app/?utm=campaign", "example.com", {
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    });

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe("http://example.fr/app/?utm=campaign");
  });

  it("renders locale-switcher links with basePath on cross-domain hrefs", async () => {
    const res = await requestNodeServerWithHost(prodPort, "/app/about/", "example.com");

    expect(res.status).toBe(200);
    expect(res.body).toContain('href="http://example.fr/app/about" id="switch-locale"');
  });

  it("preserves domain identity for only-generated revalidation with basePath", async () => {
    const before = await requestNodeServerWithHost(prodPort, "/app/isr-about/", "example.fr");
    const beforeRenderedAt = before.body.match(/<p id="renderedAt">([^<]+)<\/p>/)?.[1];

    const revalidate = await requestNodeServerWithHost(
      prodPort,
      "/app/api/revalidate/?path=%2Fapp%2Fisr-about%2F&onlyGenerated=1",
      "example.fr",
    );
    expect(revalidate.status).toBe(200);
    expect(JSON.parse(revalidate.body)).toEqual({ revalidated: true });

    const after = await requestNodeServerWithHost(prodPort, "/app/isr-about/", "example.fr");
    expect(after.body).toContain('<p id="locale">fr</p>');
    expect(after.body.match(/<p id="renderedAt">([^<]+)<\/p>/)?.[1]).not.toBe(beforeRenderedAt);
  });
});
