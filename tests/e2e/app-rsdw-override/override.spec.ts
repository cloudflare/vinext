import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const APP_FIXTURE = path.resolve(process.cwd(), "tests/fixtures/app-with-src");

test("builds and hydrates with an explicitly installed RSDW runtime override", async ({
  page,
  request,
}) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(APP_FIXTURE, "package.json"), "utf8"));
  expect(manifest.dependencies).toHaveProperty("react-server-dom-webpack");
  expect(fs.existsSync(path.join(APP_FIXTURE, "node_modules/react-server-dom-webpack"))).toBe(true);

  for (const environment of ["client", "ssr", "rsc"]) {
    const moduleIds = JSON.parse(
      fs.readFileSync(path.join(APP_FIXTURE, "dist", `rsc-runtime-${environment}.json`), "utf8"),
    ) as string[];
    expect(moduleIds.length).toBeGreaterThan(0);
    expect(moduleIds.every((id) => id.includes("react-server-dom-webpack"))).toBe(true);
    expect(moduleIds.some((id) => id.includes("@vitejs/plugin-rsc/dist/vendor"))).toBe(false);
  }

  await page.goto("/");
  await expect(page.locator("#app-with-src-home")).toBeVisible();
  await waitForAppRouterHydration(page);
  await page.getByTestId("override-action").click();
  await expect(page.getByTestId("override-action-result")).toHaveText(
    "server-action:override-runtime",
  );

  const flight = await request.get("/.rsc", {
    headers: { Accept: "text/x-component", RSC: "1" },
  });
  expect(flight.status()).toBe(200);
  expect(await flight.text()).toContain("App With Src");
});
