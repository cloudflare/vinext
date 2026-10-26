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
  // A failed attempt can leave the shell stored, so a retry would skip the cold
  // runtime production this suite checks.
  test.describe.configure({ retries: 0 });
  test.skip(!backend, "requires app-router-playground deployed with a cache backend");

  test("serves a generated param as a concrete page", async ({ baseURL, request }) => {
    const response = await request.get(`${baseURL}${route}/generated`);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-nextjs-postponed"]).toBeUndefined();
    expect(await response.text()).toContain('<p id="param">generated</p>');
  });

  test("resumes the stored shell for params outside generateStaticParams", async ({
    baseURL,
    request,
  }) => {
    const resume = async () => {
      const id = randomUUID();
      const response = await request.get(`${baseURL}${route}/${id}`);
      expect(response.status()).toBe(200);
      expect(response.headers()["x-nextjs-postponed"]).toBe("1");
      // A resumed route renders on every request instead of being stored.
      expect(response.headers()["cache-control"]).toContain("no-store");
      const html = await response.text();
      expect(html).toContain(`<p id="param">${id}</p>`);
      const renderedAt = Date.parse(html.match(/<p id="rendered-at">([^<]+)<\/p>/)?.[1] ?? "");
      expect(renderedAt).not.toBeNaN();
      return { renderedAt, respondedAt: Date.parse(response.headers()["date"] ?? "") };
    };

    await resume();
    // Let the shell's cached value go stale, so a shell rendered now would
    // refresh it.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const { renderedAt, respondedAt } = await resume();
    // The request resumed the stored shell with the value it was rendered with.
    expect(respondedAt - renderedAt).toBeGreaterThan(1_500);
  });

  test("hydrates a resumed shell without errors", async ({ baseURL, page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const id = randomUUID();
    const response = await page.goto(`${baseURL}${route}/${id}`);
    expect(response?.headers()["x-nextjs-postponed"]).toBe("1");
    await expect(page.locator("#param")).toHaveText(id);
    expect(errors).toEqual([]);
  });
});

test.describe("fallback shells filled by warming", () => {
  test.skip(!backend, "requires app-router-playground deployed with a cache backend");

  test("resumes the shell warming stored with the generated path", async ({ baseURL, request }) => {
    // Let the warm-time value go stale, so a shell rendered now would refresh it.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const id = randomUUID();
    const response = await request.get(`${baseURL}/e2e/fallback-shell-warm/${id}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-nextjs-postponed"]).toBe("1");
    const html = await response.text();
    expect(html).toContain(`<p id="param">${id}</p>`);
    const renderedAt = Date.parse(html.match(/<p id="rendered-at">([^<]+)<\/p>/)?.[1] ?? "");
    const respondedAt = Date.parse(response.headers()["date"] ?? "");
    // The shell was rendered when the deploy warmed `generated`, not for this request.
    expect(respondedAt - renderedAt).toBeGreaterThan(2_000);
  });
});
