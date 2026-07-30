import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("server-only and client-only package shims", () => {
  test("client next/constants import evaluates and hydrates without process", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`${BASE}/client-constants-test`);
    await waitForAppRouterHydration(page);
    const probe = page.getByTestId("client-constants");
    await expect(probe).toHaveText("phase-production-build:0");
    await probe.click();
    await expect(probe).toHaveText("phase-production-build:1");
    expect(pageErrors).toEqual([]);
  });

  test("server component with `import server-only` renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/server-only-test`);

    await expect(page.getByTestId("server-only-heading")).toHaveText("Server Only Page");
    await expect(page.getByTestId("server-only-message")).toContainText(
      "successfully imported server-only",
    );
  });

  test("server-only page renders without JavaScript (pure SSR)", async ({ page }) => {
    // Block all JS — the page should still render since it's a Server Component
    await page.route("**/*.js", (route) => route.abort());
    await page.route("**/*.mjs", (route) => route.abort());

    await page.goto(`${BASE}/server-only-test`);

    await expect(page.getByTestId("server-only-heading")).toHaveText("Server Only Page");
  });

  test("client component with `import client-only` renders after hydration", async ({ page }) => {
    await page.goto(`${BASE}/client-only-test`);

    await expect(page.getByTestId("client-only-heading")).toHaveText("Client Only Test");
    await expect(page.getByTestId("client-only-widget")).toContainText("Client Only Widget");
  });

  test("page with client-only widget SSR includes the component HTML", async ({ page }) => {
    // Even though it's a "use client" component, SSR should pre-render it
    await page.route("**/*.js", (route) => route.abort());
    await page.route("**/*.mjs", (route) => route.abort());

    await page.goto(`${BASE}/client-only-test`);

    // The heading (from the server component page) should render
    await expect(page.getByTestId("client-only-heading")).toHaveText("Client Only Test");
    // The client-only widget should also be pre-rendered in SSR HTML
    await expect(page.getByTestId("client-only-widget")).toBeVisible();
  });
});
