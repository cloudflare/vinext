import { expect, test } from "../../fixtures";

test("framework head insertion stays outside beforeInteractive script data", async ({ page }) => {
  const payload =
    '</head><img data-head-insertion-payload src="x" onerror="self.__headInsertionPwned=true">';
  const response = await page.goto(`/head-insertion-context?theme=${encodeURIComponent(payload)}`);

  expect(response?.status()).toBe(200);
  const rawHtml = await response!.text();
  const parsedResponse = await page.evaluate((html) => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    return {
      payloadElements: parsed.querySelectorAll("img[data-head-insertion-payload]").length,
      themeScript: parsed.querySelector("#head-insertion-theme")?.textContent,
    };
  }, rawHtml);
  expect(parsedResponse).toEqual({
    payloadElements: 0,
    themeScript: `self.__headInsertionTheme = ${JSON.stringify(payload)};`,
  });

  await expect(
    page.getByRole("heading", { name: "Streaming head insertion context" }),
  ).toBeVisible();
  await expect(page.locator("img[data-head-insertion-payload]")).toHaveCount(0);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const global = self as typeof self & {
          __headInsertionPwned?: boolean;
          __headInsertionTheme?: string;
        };
        return {
          pwned: global.__headInsertionPwned === true,
          theme: global.__headInsertionTheme,
          themeScript: document.querySelector("#head-insertion-theme")?.textContent,
        };
      }),
    )
    .toEqual({
      pwned: false,
      theme: payload,
      themeScript: `self.__headInsertionTheme = ${JSON.stringify(payload)};`,
    });
});
