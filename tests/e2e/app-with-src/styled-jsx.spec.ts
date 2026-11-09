import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("styled-jsx", () => {
  // styled-jsx is CommonJS. In dev the browser must load the prebundled copy,
  // or the compiled `import _JSXStyle from "styled-jsx/style"` and the
  // registry's `import { StyleRegistry } from "styled-jsx"` fail to link.
  test("hydrates client components that use <style jsx>", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.goto(`${BASE}/styled-jsx-client`);
    await waitForAppRouterHydration(page);

    const button = page.getByTestId("styled-jsx-client-increment");
    await button.click();
    await expect(button).toHaveText("Count: 1");
    await expect(page.getByTestId("styled-jsx-client")).toHaveCSS("color", "rgb(128, 0, 128)");
    expect(errors).toEqual([]);
  });
});
