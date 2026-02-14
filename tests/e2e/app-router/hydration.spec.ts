import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("App Router Hydration", () => {
  test("use client Counter component hydrates and becomes interactive", async ({
    page,
  }) => {
    await page.goto(`${BASE}/interactive`);

    // SSR should render the initial count
    await expect(page.locator('[data-testid="count"]')).toContainText(
      "Count:",
    );

    // Wait for hydration to complete — the browser entry fetches the RSC
    // stream before hydrating, which takes a moment. We wait for the
    // Increment button to be attached and then retry clicks.
    const incrementBtn = page.locator("button", { hasText: "Increment" });
    await incrementBtn.waitFor({ state: "attached" });

    // Wait until hydration is complete by polling — click and check
    await expect(async () => {
      await incrementBtn.click();
      const text = await page.locator('[data-testid="count"]').textContent();
      expect(text).not.toBe("Count: 0");
    }).toPass({ timeout: 10_000 });

    // Now the component is hydrated. Reset by navigating fresh.
    await page.goto(`${BASE}/interactive`);
    await expect(page.locator('[data-testid="count"]')).toContainText(
      "Count:",
    );

    // Wait for hydration again
    await expect(async () => {
      await incrementBtn.click();
      const text = await page.locator('[data-testid="count"]').textContent();
      expect(text).not.toBe("Count: 0");
    }).toPass({ timeout: 10_000 });

    // Verify sequential clicks work
    // We don't know exact count since polling may have clicked multiple
    // times. Just verify clicking changes the value.
    const currentText = await page
      .locator('[data-testid="count"]')
      .textContent();
    const currentCount = parseInt(currentText!.replace("Count: ", ""), 10);
    await incrementBtn.click();
    await expect(page.locator('[data-testid="count"]')).toHaveText(
      `Count: ${currentCount + 1}`,
    );
  });

  test("server component content coexists with client component", async ({
    page,
  }) => {
    await page.goto(`${BASE}/interactive`);

    // Server-rendered heading should be there
    await expect(page.locator("h1")).toHaveText("Interactive Page");
    // Use first() to avoid strict mode violation (multiple <p> elements)
    await expect(page.locator("main > p").first()).toContainText(
      "This page mixes server and client components.",
    );

    // Client component should also be interactive after hydration
    const incrementBtn = page.locator("button", { hasText: "Increment" });
    await expect(async () => {
      await incrementBtn.click();
      const text = await page.locator('[data-testid="count"]').textContent();
      expect(text).not.toBe("Count: 0");
    }).toPass({ timeout: 10_000 });
  });
});
