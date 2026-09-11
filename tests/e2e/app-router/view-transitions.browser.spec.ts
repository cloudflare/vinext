import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createBuilder, createServer, type ViteDevServer } from "vite";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";
import { waitForAppRouterHydration } from "../helpers";

// Ported from Next.js: test/e2e/app-dir/view-transitions/view-transitions.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/view-transitions/view-transitions.test.ts
// Also assert real browser animations, default types, and superseded requests.
for (const mode of ["development", "production"] as const) {
  test.describe(`React View Transitions (${mode})`, () => {
    let fixtureRoot: string;
    let baseUrl: string;
    let devServer: ViteDevServer | undefined;
    let prodServer: ChildProductionServer | undefined;

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-view-transitions-"));
      await fs.mkdir(path.join(fixtureRoot, "node_modules"));
      const source = path.resolve("tests/fixtures/app-basic/node_modules");
      for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        if (entry.name.startsWith(".vite")) continue;
        await fs.symlink(
          path.join(source, entry.name),
          path.join(fixtureRoot, "node_modules", entry.name),
          entry.isDirectory() ? "junction" : "file",
        );
      }
      await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"type":"module"}');
      await fs.writeFile(
        path.join(fixtureRoot, "next.config.mjs"),
        "export default { experimental: { viewTransition: true, staleTimes: { dynamic: 30 } } };",
      );
      await fs.mkdir(path.join(fixtureRoot, "app"));
      await fs.writeFile(
        path.join(fixtureRoot, "app/layout.tsx"),
        `import { ViewTransition } from 'react';
import Link from 'next/link';
export default function Layout({ children }) {
  return <html><head><link rel="icon" href="data:,"/><style>{'::view-transition-group(*) { animation-duration: 0.05s; }'}</style></head><body>
    <nav>
      <Link href="/typed" prefetch={false} transitionTypes={['slide']}>Typed</Link>
      <Link href="/default" prefetch={false}>Default</Link>
      <Link href="/prefetched" prefetch={true} transitionTypes={['prefetched']}>Prefetched</Link>
      <Link href="/slow" prefetch={false} transitionTypes={['stale']}>Slow</Link>
      <Link href="/winner" prefetch={false} transitionTypes={['winner']}>Winner</Link>
    </nav>
    <ViewTransition name="page" default={{ slide: 'slide' }}>{children}</ViewTransition>
  </body></html>;
}`,
      );
      await fs.writeFile(
        path.join(fixtureRoot, "app/page.tsx"),
        "export default function Page() { return <main>home</main>; }",
      );
      for (const route of ["typed", "default", "prefetched", "slow", "winner"]) {
        await fs.mkdir(path.join(fixtureRoot, "app", route));
        await fs.writeFile(
          path.join(fixtureRoot, "app", route, "page.tsx"),
          `export default function Page() { return <main>${route}</main>; }`,
        );
      }
      const vinext = (await import("../../../packages/vinext/src/index.js")).default;
      const config = {
        root: fixtureRoot,
        configFile: false as const,
        plugins: [vinext({ appDir: fixtureRoot })],
        logLevel: "silent" as const,
      };
      if (mode === "development") {
        devServer = await createServer({ ...config, server: { host: "127.0.0.1", port: 0 } });
        await devServer.listen();
        const address = devServer.httpServer!.address();
        if (!address || typeof address === "string") throw new Error("Missing dev server port");
        baseUrl = `http://127.0.0.1:${address.port}`;
      } else {
        const builder = await createBuilder(config);
        await builder.buildApp();
        prodServer = await startChildProductionServer(fixtureRoot);
        baseUrl = `http://127.0.0.1:${prodServer.port}`;
      }
    });

    test.afterAll(async () => {
      await devServer?.close();
      if (prodServer) await stopChildProductionServer(prodServer);
      if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
    });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        const original = document.startViewTransition?.bind(document);
        const records: { types: string[]; text: string | null }[] = [];
        Object.assign(window, { viewTransitionRecords: records });
        if (!original) return;
        document.startViewTransition = (options) => {
          const transition = original(options);
          const record = {
            types: typeof options === "object" ? Array.from(options.types ?? []) : [],
            text: null as string | null,
          };
          records.push(record);
          void transition.updateCallbackDone.then(
            () => {
              record.text = document.querySelector("main")?.textContent ?? null;
            },
            () => {},
          );
          return transition;
        };
      });
    });

    test("animates typed, default, prefetched and cached Link navigations", async ({ page }) => {
      const errors: string[] = [];
      const requests = new Map<string, number>();
      let prefetchFinished = false;
      page.on("request", (request) => {
        if (request.headers().rsc !== "1") return;
        const pathname = new URL(request.url()).pathname;
        requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
      });
      page.on("requestfinished", (request) => {
        if (new URL(request.url()).pathname === "/prefetched" && request.headers().rsc === "1")
          prefetchFinished = true;
      });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) errors.push(message.text());
      });
      await page.goto(baseUrl);
      await waitForAppRouterHydration(page);
      if (mode === "production") await expect.poll(() => prefetchFinished).toBe(true);
      for (const [label, route, type] of [
        ["Typed", "typed", "slide"],
        ["Default", "default", null],
        ["Prefetched", "prefetched", "prefetched"],
        ["Typed", "typed", "slide"],
      ] as const) {
        const requestsBeforeClick = requests.get(`/${route}`) ?? 0;
        await page.evaluate(() => {
          (
            window as unknown as Window & { viewTransitionRecords: unknown[] }
          ).viewTransitionRecords.length = 0;
        });
        await page.getByRole("link", { name: label, exact: true }).click();
        await expect(page.locator("main")).toHaveText(route);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as Window & {
                    viewTransitionRecords: { types: string[]; text: string | null }[];
                  }
                ).viewTransitionRecords,
            ),
          )
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                text: route,
                types: type ? [type] : [],
              }),
            ]),
          );
        if (
          mode === "production" &&
          (route === "prefetched" || (route === "typed" && requestsBeforeClick > 0))
        ) {
          expect(requests.get(`/${route}`), route).toBe(requestsBeforeClick);
        }
      }
      expect(errors).toEqual([]);
    });

    test("completes navigation without the browser View Transition API", async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(document, "startViewTransition", {
          value: undefined,
          configurable: true,
        });
      });
      await page.goto(baseUrl);
      await waitForAppRouterHydration(page);
      await page.getByRole("link", { name: "Typed", exact: true }).click();
      await expect(page.locator("main")).toHaveText("typed");
    });

    test("does not animate a superseded response", async ({ page }) => {
      await page.goto(baseUrl);
      await waitForAppRouterHydration(page);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requested!: () => void;
      const started = new Promise<void>((resolve) => {
        requested = resolve;
      });
      let delivered!: () => void;
      const delivery = new Promise<void>((resolve) => {
        delivered = resolve;
      });
      await page.route("**/slow*", async (route) => {
        const response = await route.fetch();
        requested();
        await held;
        // Supersession aborts this browser request while its response is held.
        try {
          await route.fulfill({ response });
        } catch {
        } finally {
          delivered();
        }
      });
      try {
        await page.getByRole("link", { name: "Slow", exact: true }).click();
        await started;
        await page.getByRole("link", { name: "Winner", exact: true }).click();
        await expect(page.locator("main")).toHaveText("winner");
      } finally {
        release();
      }
      await delivery;
      await expect(page.locator("main")).toHaveText("winner");
      const records = await page.evaluate(
        () =>
          (
            window as unknown as Window & {
              viewTransitionRecords: { types: string[]; text: string | null }[];
            }
          ).viewTransitionRecords,
      );
      expect(
        records.some((record) => record.types.includes("stale") || record.text === "slow"),
      ).toBe(false);
      expect(records.some((record) => record.types.includes("winner"))).toBe(true);
    });
  });
}
