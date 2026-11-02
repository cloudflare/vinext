import { expect, test } from "../fixtures";

const BASE = "http://localhost:4173";

// Ported from Next.js: test/integration/next-dynamic/test/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/integration/next-dynamic/test/index.test.ts
// (development mode; the production-mode run is in ../pages-router-prod/next-dynamic.spec.ts)
test.describe("next/dynamic (Pages Router)", () => {
  test("should render server value", async ({ request }) => {
    const res = await request.get(`${BASE}/nextjs-compat/next-dynamic`);
    expect(await res.text()).toMatch(/the-server-value/i);
  });

  test("should render dynamic server rendered values on client mount", async ({
    page,
    consoleErrors,
  }) => {
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));
    await page.goto(`${BASE}/nextjs-compat/next-dynamic`);

    await expect(page.locator("#first-render")).not.toHaveText("the-server-value");
    expect(await page.locator("#first-render").textContent()).toMatch(
      /^Index<!--\/?(\$|\s)-->1(<!--\/?(\$|\s)-->)+2(<!--\/?(\$|\s)-->)+3(<!--\/?(\$|\s)-->)+4(<!--\/?(\$|\s)-->)+4$/,
    );

    // should not print "invalid-dynamic-suspense" warning in browser's console
    expect(logs.join("\n")).not.toContain(
      "https://nextjs.org/docs/messages/invalid-dynamic-suspense",
    );
    void consoleErrors;
  });
});
