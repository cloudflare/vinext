import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createNextIntlFixture } from "../../next-intl-fixture";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";
import {
  startChildViteDevServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";

test.setTimeout(60_000);

for (const options of [
  {
    name: "Cloudflare with hoisted dependencies",
    cloudflare: true,
    layout: "hoisted",
    convention: "proxy",
  },
  {
    name: "Cloudflare with isolated dependencies",
    cloudflare: true,
    layout: "isolated",
    convention: "middleware",
  },
  {
    name: "Node with isolated dependencies",
    cloudflare: false,
    layout: "isolated",
    convention: "middleware",
  },
  {
    name: "explicit provider props without request config",
    cloudflare: false,
    layout: "isolated",
    convention: "middleware",
    requestConfig: false,
  },
]) {
  test(`next-intl hydrates, navigates, and preserves context through HMR: ${options.name}`, async ({
    page,
  }) => {
    const root = await createNextIntlFixture(options);
    let server: ChildProductionServer | undefined;
    const errors: string[] = [];
    const documents: string[] = [];
    const rscRequests: string[] = [];
    // The fixture has no favicon; keep its 404 out of the application error check.
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`);
    });
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
      if (isAppRouterRscRequestForPath(request, "/de")) rscRequests.push(request.url());
    });
    try {
      // Readiness is signalled by the child process; no HTTP warmup request.
      server = await startChildViteDevServer(root);
      const response = await page.goto(`http://127.0.0.1:${server.port}/en`);
      expect(response?.status()).toBe(200);
      await waitForAppRouterHydration(page);
      await expect(page.getByTestId("client-greeting")).toHaveText("Hello World");
      await page.getByTestId("translation-counter").click();
      await expect(page.getByTestId("translation-counter")).toHaveText("1");

      await page.getByTestId("locale-link").click();
      await expect(page).toHaveURL(/\/de$/);
      await expect(page.getByTestId("client-greeting")).toHaveText("Hallo Welt");
      expect(rscRequests.length).toBeGreaterThan(0);

      // The translation hook must keep the provider's context after Fast Refresh.
      // Next.js context/HMR coverage: https://github.com/vercel/next.js/blob/canary/test/e2e/ssr-react-context/index.test.ts
      const greeting = path.join(
        root,
        options.convention === "proxy" ? "src" : "",
        "app/[locale]/greeting.tsx",
      );
      const counter = page.getByTestId("translation-counter");
      const count = String(Number(await counter.textContent()) + 1);
      await counter.click();
      await expect(counter).toHaveText(count);
      await fs.writeFile(
        greeting,
        (await fs.readFile(greeting, "utf8")).replace('{t("title")}', '{t("title")} updated'),
      );
      await expect(page.getByTestId("client-greeting")).toHaveText("Hallo Welt updated");
      await expect(counter).toHaveText(count);
      expect(documents).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      try {
        if (server) await stopChildProductionServer(server);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
}
