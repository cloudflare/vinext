import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/hybrid-i18n-api-handoff");

describe("hybrid i18n API handoff", () => {
  // Next.js treats locale normalization and config rewrites as separate routing
  // events. A locale-prefixed API pathname does not claim the unprefixed route.
  // Ported from Next.js: test/e2e/i18n-api-support/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/i18n-api-support/index.test.ts
  it.each(["development", "production"] as const)(
    "distinguishes inferred and explicit locales when handing off to the App Router in %s",
    async (mode) => {
      const fixtureRoot = await createIsolatedFixture(
        FIXTURE_DIR,
        `vinext-hybrid-i18n-api-handoff-${mode}-`,
      );
      let closeServer: (() => Promise<void>) | undefined;

      try {
        let baseUrl: string;
        if (mode === "development") {
          const started = await startFixtureServer(fixtureRoot, { appRouter: true });
          closeServer = () => started.server.close();
          baseUrl = started.baseUrl;
        } else {
          const builder = await createBuilder({
            root: fixtureRoot,
            configFile: false,
            plugins: [vinext({ appDir: fixtureRoot })],
            logLevel: "silent",
          });
          await builder.buildApp();

          const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
          const started = await startProdServer({
            port: 0,
            host: "127.0.0.1",
            outDir: path.join(fixtureRoot, "dist"),
            noCompression: true,
          });
          const server = started.server;
          closeServer = () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Hybrid i18n production fixture did not bind to a TCP port");
          }
          baseUrl = `http://127.0.0.1:${address.port}`;
        }

        const direct = await fetch(`${baseUrl}/api/direct`);
        expect(direct.status).toBe(200);
        await expect(direct.json()).resolves.toEqual({ router: "app" });

        const localePrefixed = await fetch(`${baseUrl}/fr/api/direct`);
        expect(localePrefixed.status).toBe(404);

        // Ported from Next.js: test/e2e/app-dir/i18n-app-pages-domain-routing/i18n-app-pages-domain-routing.test.ts
        // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/i18n-app-pages-domain-routing/i18n-app-pages-domain-routing.test.ts
        for (const rewrite of ["before", "after", "fallback", "chain"]) {
          const inferred = await fetch(`${baseUrl}/${rewrite}/item`);
          expect(inferred.status, rewrite).toBe(200);
          await expect(inferred.text(), rewrite).resolves.toContain(
            '<p id="plain-rewrite">item</p>',
          );

          const explicit = await fetch(`${baseUrl}/fr/${rewrite}/item`);
          expect(explicit.status, rewrite).toBe(200);
          await expect(explicit.text(), rewrite).resolves.toContain(
            '<p id="localized-rewrite">fr:item</p>',
          );
        }

        for (const [pathname, locale] of [
          ["/pages-rewrite", "en"],
          ["/fr/pages-rewrite", "fr"],
        ]) {
          const response = await fetch(`${baseUrl}${pathname}`);
          expect(response.status, pathname).toBe(200);
          await expect(response.text(), pathname).resolves.toContain(
            `<main data-locale="${locale}">Hybrid i18n API handoff fixture</main>`,
          );
        }

        if (mode === "production") {
          // Next.js answers the locale-detection redirect before it stages
          // next.config headers, while the Pages route's own responses get them.
          // Dev serves Pages routes through its own pipeline, which still adds
          // them to this redirect.
          const localeRedirect = await fetch(`${baseUrl}/`, {
            headers: { "Accept-Language": "fr" },
            redirect: "manual",
          });
          expect(localeRedirect.status).toBe(307);
          expect(localeRedirect.headers.get("location")).toBe("/fr");
          expect(localeRedirect.headers.get("x-config-header")).toBeNull();

          const home = await fetch(`${baseUrl}/`);
          expect(home.status).toBe(200);
          expect(home.headers.get("x-config-header")).toBe("1");
        }
      } finally {
        await closeServer?.();
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    120000,
  );
});
