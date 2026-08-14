import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4173";
const pagePath = path.resolve(process.cwd(), "tests/fixtures/pages-basic/pages/hmr-state.tsx");
const mdxPagePath = path.resolve(process.cwd(), "tests/fixtures/pages-basic/pages/hmr-mdx.mdx");

async function expectHmrHead(
  page: Page,
  content: string,
  position: "before-document" | "after-document",
): Promise<void> {
  const hmrHead = page.locator('meta[name="hmr-head"]');
  await expect(hmrHead).toHaveCount(1);
  await expect(hmrHead).toHaveAttribute("content", content);

  const positions = await page.locator("head").evaluate((head) => {
    const children = [...head.children];
    return [
      'meta[charset="utf-8"]',
      'meta[name="viewport"]',
      'meta[name="hmr-head"]',
      'meta[name="description"]',
    ].map((selector) => children.findIndex((child) => child.matches(selector)));
  });
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions[0]).toBeLessThan(positions[1]!);
  if (position === "before-document") {
    expect(positions[1]).toBeLessThan(positions[2]!);
    expect(positions[2]).toBeLessThan(positions[3]!);
  } else {
    // Next.js's head-manager appends genuinely changed tags after unmanaged
    // custom Document children during Fast Refresh.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/head-manager.ts
    expect(positions[3]).toBeLessThan(positions[2]!);
  }
}

// Ported from Next.js:
// test/development/pages-dir/custom-app-hmr/index.test.ts
// test/development/basic/hmr/run-error-recovery-hmr-test.util.ts
// https://github.com/vercel/next.js/tree/canary/test/development/pages-dir/custom-app-hmr
test("Pages Fast Refresh preserves state and recovers from syntax errors", async ({ page }) => {
  const original = await readFile(pagePath, "utf8");

  try {
    await page.goto(`${BASE}/hmr-state`);
    await waitForHydration(page);
    await expectHmrHead(page, "Head version one", "before-document");
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 1");
    await page.evaluate(() => {
      (window as unknown as { __HMR_MARKER__: true }).__HMR_MARKER__ = true;
    });

    const versionTwo = original.replace(">Version one</h1>", ">Version two</h1>");
    await writeFile(pagePath, versionTwo);
    await expect(page.getByTestId("version")).toHaveText("Version two");
    await expectHmrHead(page, "Head version one", "before-document");
    await expect(page.getByTestId("count")).toHaveText("Count: 1");
    expect(
      await page.evaluate(() => (window as unknown as { __HMR_MARKER__?: true }).__HMR_MARKER__),
    ).toBe(true);

    await writeFile(
      pagePath,
      versionTwo.replace('content="Head version one"', 'content="Head version two"'),
    );
    await expectHmrHead(page, "Head version two", "after-document");
    await expect(page.getByTestId("count")).toHaveText("Count: 1");
    expect(
      await page.evaluate(() => (window as unknown as { __HMR_MARKER__?: true }).__HMR_MARKER__),
    ).toBe(true);

    await writeFile(pagePath, original.replace("return (", "return <<<BROKEN>>> ("));
    await page.waitForTimeout(1_000);

    await writeFile(
      pagePath,
      original
        .replace("Head version one", "Head version recovered")
        .replace("Version one", "Version recovered"),
    );
    await expect(page.getByTestId("version")).toHaveText("Version recovered");
    await expectHmrHead(page, "Head version recovered", "after-document");
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
