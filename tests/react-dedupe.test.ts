/**
 * Regression test: verify React packages are NOT externalized in the
 * SSR environment when App Router is active.
 *
 * When the top-level `ssr.external` includes React and Vite merges it
 * into `environments.ssr`, Node.js resolves React from vinext's package
 * scope instead of the project root — bypassing `resolve.dedupe` and
 * producing dual React instances ("Invalid hook call" errors) in
 * split-install topologies (npm link / bun link).
 */
import { describe, it, expect, afterAll } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR, PAGES_FIXTURE_DIR } from "./helpers.js";

let appServer: ViteDevServer | null = null;
let pagesServer: ViteDevServer | null = null;

afterAll(async () => {
  await appServer?.close();
  await pagesServer?.close();
});

describe("React dedupe configuration", () => {
  it("does not externalize React in SSR environment for App Router", async () => {
    appServer = await createServer({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: APP_FIXTURE_DIR })],
      logLevel: "silent",
    });

    // The resolved config's ssr.external should NOT contain React packages
    // when App Router is active. Per-environment configs handle externalization.
    const ssrExternal = appServer.config.ssr.external;
    const reactPackages = ["react", "react-dom", "react-dom/server"];

    for (const pkg of reactPackages) {
      if (Array.isArray(ssrExternal)) {
        expect(ssrExternal).not.toContain(pkg);
      }
      // If ssrExternal is true (externalize everything), that's also wrong for App Router
      expect(ssrExternal).not.toBe(true);
    }
  });

  it("externalizes React in top-level SSR config for Pages Router (no App Router)", async () => {
    pagesServer = await createServer({
      root: PAGES_FIXTURE_DIR,
      configFile: false,
      plugins: [vinext()],
      logLevel: "silent",
    });

    // Pages Router should still externalize React at the top level
    // because React is CJS and should be loaded natively by Node.
    const ssrExternal = pagesServer.config.ssr.external;

    if (Array.isArray(ssrExternal)) {
      expect(ssrExternal).toContain("react");
      expect(ssrExternal).toContain("react-dom");
    }
  });

  it("always includes React packages in resolve.dedupe", async () => {
    // Use the App Router server created above
    if (!appServer) {
      appServer = await createServer({
        root: APP_FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: APP_FIXTURE_DIR })],
        logLevel: "silent",
      });
    }

    const dedupe = appServer.config.resolve.dedupe;
    expect(dedupe).toContain("react");
    expect(dedupe).toContain("react-dom");
    expect(dedupe).toContain("react/jsx-runtime");
    expect(dedupe).toContain("react/jsx-dev-runtime");
  });
});
