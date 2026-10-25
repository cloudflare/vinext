import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Next.js runs Server Actions only while rendering the App page that routing
// finally reaches: afterFiles and fallback rewrites and Pages routes resolve
// first, and Route Handlers and Pages routes receive action POSTs untouched.
const actionHeaders = {
  "content-type": "text/plain;charset=UTF-8",
  "next-action": "0000000000000000000000000000000000000000",
};

for (const path of ["/after-files-revalidate", "/fallback-revalidate"]) {
  test(`re-renders the page that ${path} rewrites to after a Server Action`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator("h1")).toHaveText("Revalidate Test");
    await waitForAppRouterHydration(page);
    const initialTime = await page.locator("#time").textContent();
    // Client state survives only a soft RSC re-render, not a reload.
    await page.click("#action-revalidate-increment");
    await expect(page.locator("#action-revalidate-client-count")).toHaveText("1");

    await page.click("#revalidate");

    await expect(page.locator("#time")).not.toHaveText(initialTime!);
    await expect(page.locator("h1")).toHaveText("Revalidate Test");
    await expect(page.locator("#action-revalidate-client-count")).toHaveText("1");
    expect(new URL(page.url()).pathname).toBe(path);
  });
}

for (const path of ["/api/methods", "/after-files-upload", "/fallback-upload"]) {
  test(`delivers action POSTs to the route handler at ${path}`, async ({ request }) => {
    const response = await request.post(path, { headers: actionHeaders, data: "[]" });
    expect(response.status()).toBe(202);
    expect(response.headers()["x-nextjs-action-not-found"]).toBeUndefined();
    expect(await response.json()).toEqual({ message: "ok" });
  });
}

test("delivers action POSTs to a Pages API route in a hybrid app", async ({ request }) => {
  const response = await request.post("/api/multipart-byte-count", {
    headers: actionHeaders,
    data: "[]",
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ bytes: 2 });
});

test("answers an unknown action on a rewritten page with action-not-found", async ({ request }) => {
  const response = await request.post("/after-files-revalidate", {
    headers: actionHeaders,
    data: "[]",
  });
  expect(response.status()).toBe(404);
  expect(response.headers()["x-nextjs-action-not-found"]).toBe("1");
});
