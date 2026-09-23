import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

test.describe('production "use cache" server function references', () => {
  test("does not expose server-only cache helpers through derived source identities", async ({
    request,
  }) => {
    const anonymous = await request.get("/use-cache-hidden-reference?record=victim");
    expect(anonymous.status()).toBe(200);
    expect(await anonymous.text()).toContain("FORBIDDEN");

    const victim = await request.get("/use-cache-hidden-reference?record=victim", {
      headers: { Authorization: "Bearer fixture-victim-session" },
    });
    expect(victim.status()).toBe(200);
    expect(await victim.text()).toContain("VICTIM_PRIVATE_RECORD");

    const defaultVictim = await request.get(
      "/use-cache-hidden-reference?record=victim&source=default",
      { headers: { Authorization: "Bearer fixture-victim-session" } },
    );
    expect(defaultVictim.status()).toBe(200);
    expect(await defaultVictim.text()).toContain("VICTIM_DEFAULT_PRIVATE_RECORD");

    const predictableReferenceKey = createHash("sha256")
      .update("app/use-cache-hidden-reference/records.ts")
      .digest("hex")
      .slice(0, 12);
    for (const [exportName, secret] of [
      ["readRecord", "VICTIM_PRIVATE_RECORD"],
      ["default", "VICTIM_DEFAULT_PRIVATE_RECORD"],
    ] as const) {
      const exploit = await request.post("/use-cache-hidden-reference.rsc", {
        data: JSON.stringify(["victim"]),
        headers: {
          "Content-Type": "text/plain",
          "x-rsc-action": `${predictableReferenceKey}#${exportName}`,
        },
      });

      expect(exploit.status()).toBe(404);
      expect(exploit.headers()["x-nextjs-action-not-found"]).toBe("1");
      expect(await exploit.text()).not.toContain(secret);
    }
  });

  test("invokes default-exported server actions from cached modules", async ({ page }) => {
    await page.goto("/use-cache-client-import");
    await waitForAppRouterHydration(page);

    await page.locator("#call-client-imported-default").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("1");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(
      "client-default:direct",
    );
  });

  test("separates arguments for file-level cached exports imported by a Client Component", async ({
    page,
  }) => {
    await page.goto("/use-cache-client-import");
    await waitForAppRouterHydration(page);

    await page.locator("#call-client-imported-cache").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("1");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(
      /^client-cache:direct:[0-9.e+-]+$/,
    );
    const directResult = await page.getByTestId("client-imported-cache-result").innerText();

    await page.locator("#call-client-imported-cache-other").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("2");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(
      /^client-cache:other:[0-9.e+-]+$/,
    );
    const otherResult = await page.getByTestId("client-imported-cache-result").innerText();
    expect(otherResult).not.toBe(directResult);

    await page.locator("#call-client-imported-cache").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("3");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(directResult);

    await page.locator("#call-client-imported-server").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("4");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(
      /^client-server:direct:[0-9.e+-]+$/,
    );
    const firstServerResult = await page.getByTestId("client-imported-cache-result").innerText();

    await page.locator("#call-client-imported-server").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("5");
    await expect(page.getByTestId("client-imported-cache-result")).not.toHaveText(
      firstServerResult,
    );
  });

  test("runs inline use-server and use-cache exports owned by different plugins", async ({
    page,
  }) => {
    await page.goto("/use-cache-mixed-ownership");
    await expect(page.getByTestId("use-cache-mixed-ownership-page")).toBeVisible();
    await waitForAppRouterHydration(page);

    await page.locator("#call-mixed-builtin").click();
    await expect(page.getByTestId("mixed-builtin-call-count")).toHaveText("1");
    await expect(page.getByTestId("mixed-builtin-result")).toHaveText("builtin");

    await page.locator("#call-mixed-flexible").click();
    await expect(page.getByTestId("mixed-flexible-call-count")).toHaveText("1");
    const cachedResult = await page.getByTestId("mixed-flexible-result").innerText();
    expect(cachedResult).toMatch(/^cached:[0-9.e+-]+$/);

    await page.locator("#call-mixed-flexible").click();
    await expect(page.getByTestId("mixed-flexible-call-count")).toHaveText("2");
    await expect(page.getByTestId("mixed-flexible-result")).toHaveText(cachedResult);
  });

  test('caches an inline "use cache" function during server render inside a file-level "use server" module', async ({
    page,
  }) => {
    await page.goto("/use-cache-transform-coverage");

    const aggregateResult = await page.getByTestId("use-cache-transform-coverage").innerText();
    const serverResult = aggregateResult.split("|")[1];
    if (!serverResult) throw new Error("Missing server-boundary result");
    expect(serverResult).toMatch(/^server-boundary:[0-9.e+-]+$/);

    await page.reload();
    const repeatedResult = await page.getByTestId("use-cache-transform-coverage").innerText();
    expect(repeatedResult.split("|")[1]).toBe(serverResult);
  });

  test("replays cached RSC through SSR and invokes nested functions from the browser", async ({
    page,
  }) => {
    await page.goto("/use-cache-nested-fn-props");
    await expect(page.getByTestId("use-cache-nested-fn-props-page")).toBeVisible();
    const cachedRender = await page.getByTestId("nested-cache-render").textContent();

    // Force a second server request so this test exercises the cache-hit Flight
    // replay path before invoking the nested references in the browser.
    await page.reload();
    await expect(page.getByTestId("use-cache-nested-fn-props-page")).toBeVisible();
    await expect(page.getByTestId("nested-cache-render")).toHaveText(cachedRender!);
    await waitForAppRouterHydration(page);

    await page.locator("#submit-button-date").click();
    await expect(page.locator("#date")).toHaveText(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const firstDate = await page.locator("#date").textContent();
    await page.locator("#submit-button-date").click();
    await expect(page.locator("#date")).toHaveText(firstDate!);

    await page.locator("#submit-button-random").click();
    await expect(page.locator("#random")).toHaveText(/^\d+\.\d+$/);
    const firstRandom = await page.locator("#random").textContent();
    await page.locator("#submit-button-random").click();
    await expect(page.locator("#random")).toHaveText(firstRandom!);

    await page.locator("#submit-button-message").click();
    await expect(page.locator("#message")).toHaveText(
      /^message:closure-captured-bound-arg-vinext:[0-9.e+-]+$/,
    );
    const firstMessage = await page.locator("#message").textContent();
    await page.locator("#submit-button-message").click();
    await expect(page.locator("#message")).toHaveText(firstMessage!);

    await page.locator("#submit-button-message-other").click();
    await expect(page.locator("#message-other")).toHaveText(
      /^message:closure-captured-bound-arg-other:[0-9.e+-]+$/,
    );
    const otherMessage = await page.locator("#message-other").textContent();
    expect(otherMessage).not.toBe(firstMessage);
    await page.locator("#submit-button-message-other").click();
    await expect(page.locator("#message-other")).toHaveText(otherMessage!);
  });
});
