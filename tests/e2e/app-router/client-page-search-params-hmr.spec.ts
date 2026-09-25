import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4174";

test("a client page reads the query an HMR re-render was rewritten to", async ({
  context,
  page,
}) => {
  const layoutPath = path.resolve(
    process.cwd(),
    "tests/fixtures/app-basic/app/client-page-search-params/hmr/layout.tsx",
  );
  const original = await fs.readFile(layoutPath, "utf8");

  try {
    await page.goto(`${BASE}/client-page-search-params/hmr`);
    await waitForAppRouterHydration(page);
    const query = page.getByTestId("hmr-client-page-q");
    await expect(query).toHaveAttribute("data-hydrated", "true");
    await expect(query).toHaveText("(none)");

    // The cookie makes the next render rewrite to ?q=from-cookie, while the
    // URL stays the same.
    await context.addCookies([{ name: "client-page-hmr-q", value: "1", url: BASE }]);
    await fs.writeFile(layoutPath, original.replace("before edit", "after edit"));

    await expect(page.getByTestId("hmr-client-page-marker")).toHaveText("after edit");
    await expect(query).toHaveText("from-cookie");
  } finally {
    await fs.writeFile(layoutPath, original);
  }
});
