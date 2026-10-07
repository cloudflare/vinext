import { test, expect, type APIResponse, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Tests shared by the dev and preview specs for examples/app-router-nitro.

async function gotoHydrated(page: Page, url: string): Promise<void> {
  // The home page renders an eager remote image; wait for the document, not
  // the load event, and rely on the explicit hydration wait.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForAppRouterHydration(page);
}

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => Reflect.set(window, "__nitroE2eDocument", true));
}

async function expectSameDocument(page: Page): Promise<void> {
  expect(await page.evaluate(() => Reflect.get(window, "__nitroE2eDocument"))).toBe(true);
}

function setCookieValues(response: APIResponse, name: string): string[] {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value.split(";")[0])
    .filter((pair) => pair.startsWith(`${name}=`))
    .map((pair) => pair.slice(name.length + 1));
}

export function defineNitroAppTests(): void {
  test("renders and hydrates the home page", async ({ page }) => {
    await gotoHydrated(page, "/");
    await expect(page.locator("h1")).toHaveText("vinext + nitro");

    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("1");
  });

  test("runs middleware on page requests", async ({ request }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(200);
    expect(response.headers()["x-vinext-middleware"]).toBe("active");
    expect(setCookieValues(response, "visit-count")).toEqual(["1"]);
  });

  test("renders a page that reads request headers", async ({ page }) => {
    const response = await page.goto("/about");
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("navigates on the client with Link and useRouter", async ({ page }) => {
    await gotoHydrated(page, "/");
    await markDocument(page);

    await page.getByRole("link", { name: "Blog Post" }).click();
    await expect(page).toHaveURL("/blog/hello-world");
    await expect(page.getByTestId("blog-title")).toHaveText("Hello World");
    await expectSameDocument(page);

    await page.goBack();
    await expect(page.getByTestId("pathname")).toHaveText("pathname: /");
    await page.getByTestId("nav-about").click();
    await expect(page).toHaveURL("/about");
    await expect(page.locator("h1")).toHaveText("About");
    await expectSameDocument(page);
  });

  test("updates search params from next/form", async ({ page }) => {
    await gotoHydrated(page, "/");
    await markDocument(page);

    await page.locator('input[name="q"]').fill("nitro");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL("/?q=nitro");
    await expect(page.getByTestId("search-params")).toHaveText("searchParams: q=nitro");
    await expectSameDocument(page);
  });

  test("submits a server action", async ({ page }) => {
    const entry = `nitro-${Date.now()}`;
    await gotoHydrated(page, "/about");

    await page.getByTestId("guestbook-input").fill(entry);
    await page.getByTestId("guestbook-submit").click();
    await expect(page.getByTestId("guestbook-list")).toContainText(entry);
  });

  test("renders not-found for an unknown dynamic route param", async ({ page }) => {
    const response = await page.goto("/blog/missing-post");
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("not-found")).toHaveText("404");
  });

  test("serves route handler methods", async ({ request }) => {
    const get = await request.get("/api/hello?name=nitro");
    expect(get.status()).toBe(200);
    expect(await get.json()).toMatchObject({
      message: "Hello, nitro! From vinext with nitro.",
    });

    const post = await request.post("/api/hello", {
      data: { action: "set-theme", theme: "dark" },
    });
    expect(post.status()).toBe(200);
    expect(await post.json()).toEqual({ ok: true, action: "set-theme" });
    expect(setCookieValues(post, "theme")).toEqual(["dark"]);

    const del = await request.delete("/api/hello");
    expect(del.status()).toBe(200);
    expect(await del.json()).toEqual({ ok: true, revalidated: "blog-posts" });
  });
}
