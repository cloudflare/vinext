// Ported from Next.js: test/e2e/app-dir/client-module-with-package-type/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/client-module-with-package-type/index.test.ts
import { expect, test } from "../fixtures";
import {
  FIXTURE_HOOK_TIMEOUT_MS,
  startFixtureDevServer,
  stopFixtureDevServer,
  type FixtureDevServer,
} from "../../fixture-dev-server.js";

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-workers/fixtures/client-module-with-package-type`;
const PORT = 4203;

let server: FixtureDevServer;

test.describe("esm-client-module-without-exports", () => {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
    testInfo.setTimeout(FIXTURE_HOOK_TIMEOUT_MS);
    server = await startFixtureDevServer({
      name: "client module package type Cloudflare Worker",
      root: FIXTURE_DIR,
      port: PORT,
      command: {
        bin: "sh",
        args: [
          "-c",
          `created_vinext=0; if ! test -e node_modules/vinext && ! test -L node_modules/vinext; then ln -s ../../../../../../packages/vinext node_modules/vinext; created_vinext=1; fi; trap 'if test "$created_vinext" = 1; then rm node_modules/vinext; fi' EXIT; npx vp build && ../../../../fixtures/cf-app-basic/node_modules/.bin/wrangler dev --config dist/server/wrangler.json --port ${PORT}`,
        ],
      },
    });
  });

  test.afterAll(() => {
    stopFixtureDevServer(server?.process);
  });

  test.describe('"type": "commonjs" in package.json', () => {
    test("should render without errors: import cjs", async ({ page, consoleErrors }) => {
      await page.goto(`${server.baseUrl}/import-cjs`);
      await expect(page.locator("p")).toContainText("lib-cjs: esm");
      void consoleErrors;
    });

    test("should render without errors: require cjs", async ({ page, consoleErrors }) => {
      await page.goto(`${server.baseUrl}/require-cjs`);
      await expect(page.locator("p")).toContainText("lib-cjs: cjs");
      void consoleErrors;
    });
  });

  test.describe('"type": "module" in package.json', () => {
    test("should render without errors: import esm", async ({ page, consoleErrors }) => {
      await page.goto(`${server.baseUrl}/import-esm`);
      await expect(page.locator("p")).toContainText("lib-esm: esm");
      void consoleErrors;
    });

    test("should render without errors: require esm", async ({ page, consoleErrors }) => {
      await page.goto(`${server.baseUrl}/require-esm`);
      await expect(page.locator("p")).toContainText("lib-esm: cjs");
      void consoleErrors;
    });
  });
});
