import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createBuilder, createServer } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/hybrid-i18n-api-handoff");

describe("hybrid i18n API handoff", () => {
  it.each([
    ["disabled", false],
    ["custom", true],
    ["vite-root", true],
  ] as const)(
    "scopes the CLI build warning for %s App Router",
    async (variant, shouldWarn) => {
      const fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, `vinext-cli-i18n-${variant}-`);
      try {
        if (variant !== "disabled") {
          const routeRoot = path.join(fixtureRoot, variant === "custom" ? "custom" : "frontend");
          await fs.mkdir(routeRoot);
          await fs.rename(path.join(fixtureRoot, "app"), path.join(routeRoot, "app"));
          if (variant === "vite-root") {
            await fs.rm(path.join(fixtureRoot, "next.config.mjs"));
          } else {
            await fs.writeFile(
              path.join(fixtureRoot, "next.config.mjs"),
              `export default {
            i18n: { locales: ["en", "fr"], defaultLocale: "en" },
            async redirects() { console.error("cli-preflight-config-resolved"); return []; },
          };\n`,
            );
          }
        }
        const vinextUrl = pathToFileURL(
          path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js"),
        ).href;
        const options =
          variant === "disabled"
            ? { disableAppRouter: true }
            : { appDir: variant === "custom" ? "custom" : "." };
        const optionsSource =
          variant === "vite-root"
            ? `{ appDir: ".", nextConfig: {
                i18n: { locales: ["en", "fr"], defaultLocale: "en" },
                async redirects() { console.error("cli-preflight-config-resolved"); return []; },
              } }`
            : JSON.stringify(options);
        await fs.writeFile(
          path.join(fixtureRoot, "vite.config.mjs"),
          `import vinext from ${JSON.stringify(vinextUrl)};\nexport default { ${variant === "vite-root" ? 'root: "frontend", ' : ""}plugins: [vinext(${optionsSource})] };\n`,
        );
        const result = spawnSync(
          process.execPath,
          [path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js"), "build"],
          { cwd: fixtureRoot, encoding: "utf8", timeout: 60000 },
        );
        expect(result.status, result.stderr).toBe(0);
        if (variant === "custom") {
          expect(result.stdout).not.toContain("Building Pages Router server (hybrid)");
        }
        const expectedWarning = `i18n configuration in next.config.${variant === "vite-root" ? "js" : "mjs"} is unsupported in App Router`;
        expect(
          (result.stdout + result.stderr).split(expectedWarning),
          `${result.stdout}\n${result.stderr}`,
        ).toHaveLength(shouldWarn ? 2 : 1);
        if (variant !== "disabled") {
          expect(result.stderr.indexOf(expectedWarning)).toBeLessThan(
            result.stderr.indexOf("cli-preflight-config-resolved"),
          );
        }
      } finally {
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    120000,
  );

  it.each([
    ["cwd-only", true, false],
    ["vite-root-only", false, true],
  ] as const)(
    "reads the %s i18n warning config from the Vite root",
    async (variant, cwdI18n, viteRootI18n) => {
      const fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, `vinext-cli-i18n-${variant}-`);
      try {
        const frontendRoot = path.join(fixtureRoot, "frontend");
        await fs.mkdir(frontendRoot);
        await fs.rename(path.join(fixtureRoot, "app"), path.join(frontendRoot, "app"));
        await fs.writeFile(
          path.join(fixtureRoot, "next.config.mjs"),
          `export default {
          ${cwdI18n ? 'i18n: { locales: ["en", "fr"], defaultLocale: "en" },' : ""}
          async redirects() { console.error("cli-build-config-resolved"); return []; },
        };\n`,
        );
        await fs.writeFile(
          path.join(frontendRoot, "next.config.cjs"),
          `module.exports = ${viteRootI18n ? '{ i18n: { locales: ["en", "fr"], defaultLocale: "en" } }' : "{}"};\n`,
        );
        const vinextUrl = pathToFileURL(
          path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js"),
        ).href;
        await fs.writeFile(
          path.join(fixtureRoot, "vite.config.mjs"),
          `import vinext from ${JSON.stringify(vinextUrl)};\nexport default { root: "frontend", plugins: [vinext({ appDir: "." })] };\n`,
        );
        const result = spawnSync(
          process.execPath,
          [path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js"), "build"],
          { cwd: fixtureRoot, encoding: "utf8", timeout: 60000 },
        );
        expect(result.status, result.stderr).toBe(0);
        const warnings =
          (result.stdout + result.stderr).match(
            /i18n configuration in next\.config\.[cm]?js is unsupported in App Router/g,
          ) ?? [];
        expect(warnings).toEqual(
          viteRootI18n
            ? ["i18n configuration in next.config.cjs is unsupported in App Router"]
            : [],
        );
        expect(result.stderr).toContain("cli-build-config-resolved");
        if (viteRootI18n) {
          expect(result.stderr.indexOf(warnings[0]!)).toBeLessThan(
            result.stderr.indexOf("cli-build-config-resolved"),
          );
        }
      } finally {
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    120000,
  );

  it("warns once for an active App Router across dev and build, not for a Pages-only pass", async () => {
    const fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, "vinext-i18n-warning-");
    await fs.rename(
      path.join(fixtureRoot, "next.config.mjs"),
      path.join(fixtureRoot, "next.config.ts"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const disableAppRouter of [true, false]) {
        const server = await createServer({
          root: fixtureRoot,
          configFile: false,
          plugins: [vinext({ appDir: fixtureRoot, disableAppRouter })],
          logLevel: "silent",
          server: { middlewareMode: true },
        });
        await server.close();
        expect(
          warn.mock.calls.filter(([message]) =>
            String(message).includes("unsupported in App Router"),
          ),
        ).toHaveLength(disableAppRouter ? 0 : 1);
      }

      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [vinext({ appDir: fixtureRoot })],
        logLevel: "silent",
      });
      await builder.buildApp();
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("unsupported in App Router"),
        ),
      ).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 120000);

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
