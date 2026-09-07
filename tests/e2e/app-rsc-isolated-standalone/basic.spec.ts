import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

test("runs a relocated App Router standalone artifact from a genuinely RSDW-free install", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("RSDW-free standalone");
  await waitForAppRouterHydration(page);

  await page.locator("#counter").click();
  await expect(page.locator("#counter")).toHaveText("count:1");

  await page.getByRole("link", { name: "About" }).click();
  await expect(page.locator("h1")).toHaveText("Isolated about");

  await page.getByRole("link", { name: "Home" }).click();
  await page.locator("#action").click();
  await expect(page.locator("#action-result")).toHaveText("action:isolated");

  const flight = await request.get("/.rsc", {
    headers: { Accept: "text/x-component", RSC: "1" },
  });
  expect(flight.status()).toBe(200);
  expect(await flight.text()).toContain("RSDW-free standalone");
});
