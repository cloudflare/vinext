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
  // Pages Router only — no RSC pipeline, so separate build() calls work.
  // For App Router, use createBuilder().buildApp() instead.
  await build({
    root: tmpDir,
    configFile: false,
    plugins: [vinext()],
    logLevel: "silent",
    build: {
      outDir: path.join(outDir, "server"),
      ssr: "virtual:vinext-server-entry",
      rollupOptions: { output: { entryFileNames: "entry.js" } },
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
      rollupOptions: { input: "virtual:vinext-client-entry" },
    },
  });

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const server = await startProdServer({
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
});
