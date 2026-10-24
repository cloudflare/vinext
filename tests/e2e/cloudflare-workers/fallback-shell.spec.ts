import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Runs against app-router-playground deployed with --warm-cache and no
// prerender, so every fallback shell is produced at runtime.
const backend = process.env.VINEXT_E2E_FALLBACK_SHELL_BACKEND;
const route = "/e2e/fallback-shell";

test.beforeAll(async ({ baseURL, request }) => {
  if (!backend || !baseURL) return;
  test.setTimeout(120_000);
  // A newly deployed Worker can take a moment to serve its workers.dev URL.
  await expect
    .poll(
      async () => {
        const response = await request.get(`${baseURL}${route}/generated`);
        return response.status();
      },
      { intervals: [1_000], timeout: 90_000 },
    )
    .toBe(200);
});

test.describe("fallback shells on a warmed deploy", () => {
  test.skip(!backend, "requires app-router-playground deployed with a cache backend");

  test("serves a generated param as a concrete page", async ({ baseURL, request }) => {
    const response = await request.get(`${baseURL}${route}/generated`);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-nextjs-postponed"]).toBeUndefined();
    expect(await response.text()).toContain('<p id="param">generated</p>');
  });

  test("resumes the shell for params outside generateStaticParams", async ({
    baseURL,
    request,
  }) => {
    const renderedAt = new Set<string>();
    for (const id of [randomUUID(), randomUUID()]) {
      const response = await request.get(`${baseURL}${route}/${id}`);
      expect(response.status()).toBe(200);
      expect(response.headers()["x-nextjs-postponed"]).toBe("1");
      // A resumed route renders on every request instead of being stored.
      expect(response.headers()["cache-control"]).toContain("no-store");
      const html = await response.text();
      expect(html).toContain(`<p id="param">${id}</p>`);
      renderedAt.add(html.match(/<p id="rendered-at">([^<]+)<\/p>/)?.[1] ?? "");
    }
    // Both requests resume the shell with its cached values.
    expect(renderedAt.size).toBe(1);
  });

  test("hydrates a resumed shell without errors", async ({ baseURL, page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const id = randomUUID();
    await page.goto(`${baseURL}${route}/${id}`);
    await expect(page.locator("#param")).toHaveText(id);
    expect(errors).toEqual([]);
  });
});
