import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

// https://github.com/cloudflare/vinext/issues/4007: a Server Component imports
// one export from a sideEffects:false barrel whose unused leaf calls
// createContext() at module scope. Dev must follow the re-export instead of
// evaluating the whole barrel in the RSC environment.
test("server component renders one export of a side-effect-free barrel", async ({ page }) => {
  const response = await page.goto(`${BASE}/side-effect-free-barrel`);

  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("side-effect-free-barrel")).toHaveText("Server-safe barrel export");
});
