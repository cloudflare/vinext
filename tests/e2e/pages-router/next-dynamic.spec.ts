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

  // Pages Router dynamic() components render on the server, and the client
  // preloads them (__NEXT_DATA__.dynamicIds) before hydrating, so they hydrate
  // in place and useId() values match.
  test("useId() inside a dynamic() component matches on hydration", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(`${BASE}/nextjs-compat/next-dynamic-use-id`);
    const html = await response!.text();
    const ssrId = /<span id="dynamic-use-id-value">([^<]+)<\/span>/.exec(html)?.[1];
    expect(ssrId).toBeTruthy();

    await page.waitForFunction(() => window.__NEXT_HYDRATED === true);
    // A mismatched id makes React client-render the component with its own id.
    await expect(page.locator("#dynamic-use-id[data-hydrated] #dynamic-use-id-value")).toHaveText(
      ssrId!,
    );
    await expect(page.locator("#dynamic-use-id input")).toHaveAttribute("id", ssrId!);
    // A ref on the dynamic() component gets Next.js's `{ retry }` handle.
    await expect(page.locator("#dynamic-ref-retry")).toHaveText("retry");
    void consoleErrors;
  });
});
