import { expect, test } from "../fixtures";

// Ported from Next.js: test/e2e/app-dir/worker/worker.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/worker/worker.test.ts
// Reproduction from: https://github.com/cloudflare/vinext/issues/2600

test("runs an import.meta.url module worker in the deployed example", async ({
  page,
  consoleErrors,
}) => {
  const workerUrls: string[] = [];
  page.on("worker", (worker) => workerUrls.push(worker.url()));

  await page.goto("/web-worker");
  await expect(page.getByTestId("worker-result")).toHaveText("(not run)");

  await page.getByTestId("start-worker").click();

  await expect(page.getByTestId("worker-result")).toHaveText("worker replied: echo: ping");
  expect(workerUrls).toHaveLength(1);
  expect(new URL(workerUrls[0]!).protocol).toMatch(/^https?:$/);
  expect(new URL(workerUrls[0]!).pathname).toMatch(
    /\/_next\/static\/workers\/echo\.worker-[^/]+\.js$/,
  );

  void consoleErrors;
});
