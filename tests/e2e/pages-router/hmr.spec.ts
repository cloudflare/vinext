import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4173";
const pagePath = path.resolve(process.cwd(), "tests/fixtures/pages-basic/pages/hmr-state.tsx");
const mdxPagePath = path.resolve(process.cwd(), "tests/fixtures/pages-basic/pages/hmr-mdx.mdx");

// Ported from Next.js:
// test/development/pages-dir/custom-app-hmr/index.test.ts
// test/development/basic/hmr/run-error-recovery-hmr-test.util.ts
// https://github.com/vercel/next.js/tree/canary/test/development/pages-dir/custom-app-hmr
test("Pages Fast Refresh preserves state and recovers from syntax errors", async ({ page }) => {
  const original = await readFile(pagePath, "utf8");

  try {
    await page.goto(`${BASE}/hmr-state`);
    await waitForHydration(page);
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 1");
    await page.evaluate(() => {
      (window as unknown as { __HMR_MARKER__: true }).__HMR_MARKER__ = true;
    });

    await writeFile(pagePath, original.replace("Version one", "Version two"));
    await expect(page.getByTestId("version")).toHaveText("Version two");
    await expect(page.getByTestId("count")).toHaveText("Count: 1");
    expect(
      await page.evaluate(() => (window as unknown as { __HMR_MARKER__?: true }).__HMR_MARKER__),
    ).toBe(true);

    await writeFile(pagePath, original.replace("return (", "return <<<BROKEN>>> ("));
    await page.waitForTimeout(1_000);

    await writeFile(pagePath, original.replace("Version one", "Version recovered"));
    await expect(page.getByTestId("version")).toHaveText("Version recovered");
    await expect(page.getByTestId("count")).toHaveText("Count: 1");
    expect(
      await page.evaluate(() => (window as unknown as { __HMR_MARKER__?: true }).__HMR_MARKER__),
    ).toBe(true);
  } finally {
    await writeFile(pagePath, original);
  }
});

// Ported from Next.js:
// test/development/acceptance/ReactRefreshRegression.test.ts
// https://github.com/vercel/next.js/blob/canary/test/development/acceptance/ReactRefreshRegression.test.ts
test("Pages Fast Refresh updates MDX routes without a full reload", async ({ page }) => {
  const original = await readFile(mdxPagePath, "utf8");

  try {
    await page.goto(`${BASE}/hmr-mdx`);
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("MDX version one");
    await page.evaluate(() => {
      (window as unknown as { __HMR_MARKER__: true }).__HMR_MARKER__ = true;
    });

    await writeFile(mdxPagePath, original.replace("version one", "version two"));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("MDX version two");
    expect(
      await page.evaluate(() => (window as unknown as { __HMR_MARKER__?: true }).__HMR_MARKER__),
    ).toBe(true);

    await writeFile(mdxPagePath, original.replace("version one", "version three"));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("MDX version three");
    expect(
      await page.evaluate(() => (window as unknown as { __HMR_MARKER__?: true }).__HMR_MARKER__),
    ).toBe(true);
  } finally {
    await writeFile(mdxPagePath, original);
  }
});
