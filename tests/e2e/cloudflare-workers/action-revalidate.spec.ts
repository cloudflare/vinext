import { test, expect } from "../fixtures";

const BASE = "http://localhost:4176";

// Ported from Next.js: test/e2e/app-dir/actions-revalidate-remount/actions-revalidate-remount.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-revalidate-remount/actions-revalidate-remount.test.ts
test("server action revalidation preserves client state under loading.tsx", async ({
  page,
  consoleErrors,
}) => {
  const loadingLogs: string[] = [];
  page.on("console", (message) => {
    if (message.text() === "Action revalidate loading mounted") {
      loadingLogs.push(message.text());
    }
  });

  await page.goto(`${BASE}/action-revalidate`);
  await expect(page.getByTestId("action-revalidate-client-count")).toHaveText("Client count: 0");
  loadingLogs.length = 0;

  await page.getByTestId("action-revalidate-increment").click();
  await page.getByTestId("action-revalidate-increment").click();
  await page.getByTestId("action-revalidate-increment").click();
  await expect(page.getByTestId("action-revalidate-client-count")).toHaveText("Client count: 3");

  const initialTime = await page.getByTestId("action-revalidate-time").textContent();
  expect(initialTime).toBeTruthy();

  await page.getByTestId("action-revalidate-submit").click();

  await expect(page.getByTestId("action-revalidate-time")).not.toHaveText(initialTime!);
  await expect(page.getByTestId("action-revalidate-client-count")).toHaveText("Client count: 3");
  await expect(page.getByTestId("action-revalidate-loading")).toHaveCount(0);
  expect(loadingLogs).toEqual([]);

  void consoleErrors;
});
