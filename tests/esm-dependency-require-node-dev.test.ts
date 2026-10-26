/**
 * ESM dependencies that call require(), like the ESM build of @clerk/nextjs,
 * also render in Node dev, where the module runner loads them unbundled. The
 * Cloudflare dev and build paths are covered by
 * tests/e2e/esm-dependency-require.ts.
 *
 * See https://github.com/cloudflare/vinext/issues/4221.
 */
import path from "node:path";
import type { ViteDevServer } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ESM_DEPENDENCY_REQUIRE_VALUES } from "./e2e/esm-dependency-require-values.js";
import { startFixtureServer } from "./helpers.js";

const CF_APP_BASIC = path.resolve(import.meta.dirname, "fixtures/cf-app-basic");

describe("require() in ESM dependencies on the Node development runtime", () => {
  let server: ViteDevServer | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(CF_APP_BASIC, {
      // Like the fixture's vite.config.ts, without @cloudflare/vite-plugin.
      prependPlugins: [
        {
          name: "test:esm-require-dependency",
          config: () => ({
            environments: {
              rsc: {
                optimizeDeps: { exclude: ["esm-require-dependency"], include: ["esm-require-cjs"] },
              },
            },
          }),
        },
      ],
    }));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders a server component whose dependency calls require()", async () => {
    const response = await fetch(`${baseUrl}/esm-dependency-require`);
    expect(response.status).toBe(200);
    const values = Object.fromEntries(
      [...(await response.text()).matchAll(/<dd id="(\w+)">([^<]*)<\/dd>/g)].map(
        ([, name, value]) => [name, value],
      ),
    );

    expect(values).toEqual(ESM_DEPENDENCY_REQUIRE_VALUES);
  });
});
