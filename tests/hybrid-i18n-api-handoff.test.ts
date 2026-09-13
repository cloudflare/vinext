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
    "does not turn locale normalization into an App API rewrite in %s",
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
      } finally {
        await closeServer?.();
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    120000,
  );
});
