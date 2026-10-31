import { expect, test } from "./fixtures";
import { ESM_DEPENDENCY_REQUIRE_VALUES } from "./esm-dependency-require-values";

/**
 * ESM dependencies that call require(), like the ESM build of @clerk/nextjs,
 * render the same in dev, where the Worker loads them unbundled, as in a
 * build. Next.js's bundlers and vinext builds accept require() in ESM modules.
 *
 * See https://github.com/cloudflare/vinext/issues/4221.
 */
export function testEsmDependencyRequire(): void {
  test("renders a server component whose dependency calls require()", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto("/esm-dependency-require");
    expect(response?.status()).toBe(200);

    for (const [name, value] of Object.entries(ESM_DEPENDENCY_REQUIRE_VALUES)) {
      await expect(page.locator(`#${name}`)).toHaveText(value);
    }
    expect(consoleErrors).toEqual([]);
  });
}
