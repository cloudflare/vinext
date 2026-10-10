import { expect, test } from "../fixtures";

const REMOTE_ORIGIN = "http://localhost:4221";

test("host renders a federated remote component that shares the host React", async ({
  page,
  consoleErrors,
}) => {
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(REMOTE_ORIGIN)) remoteRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Module Federation host" })).toBeVisible();

  // The remote renders only after hydration. Its hooks work only if
  // getVinextReact() returns the host's React instance.
  const remoteCounter = page.getByRole("button", { name: "Remote counter: 0" });
  await expect(remoteCounter).toBeVisible();
  await remoteCounter.click();
  await expect(page.getByRole("button", { name: "Remote counter: 1" })).toBeVisible();
  expect(remoteRequests).toContain(`${REMOTE_ORIGIN}/remoteEntry.js`);

  await page.getByRole("button", { name: "Host counter: 0" }).click();
  await expect(page.getByRole("button", { name: "Host counter: 1" })).toBeVisible();

  void consoleErrors;
});

test("the remote component is not server-rendered", async ({ request }) => {
  const html = await (await request.get("/")).text();
  expect(html).toContain("Module Federation host");
  expect(html).not.toContain("Remote counter");
});
