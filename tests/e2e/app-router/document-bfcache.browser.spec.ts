import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { createBuilder } from "vite";
import { waitForAppRouterHydration } from "../helpers";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";

// Native BFCache needs full Chrome and a production document without Vite's socket.
test.skip(({ browserName }) => browserName !== "chromium", "Native Chromium BFCache regression");
test.use({ launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] } });
test.setTimeout(120_000);

// Next restores router state on persisted pageshow to avoid retrying an old MPA.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router.tsx
type RestoreProbe = typeof window & {
  __documentRestored?: boolean;
  __releaseFlight?: () => void;
  __holdDestination?: boolean;
  __pendingAttempted?: boolean;
};

for (const scenario of [
  "departed Pages navigation",
  "pending Flight",
  "failed Flight",
  "accepted destination",
]) {
  test(`a BFCache-restored App document discards its ${scenario}`, async ({ page }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-document-bfcache-"));
    let server: ChildProductionServer | undefined;
    try {
      await fs.mkdir(path.join(root, "app"));
      await fs.mkdir(path.join(root, "app/pending"));
      await fs.mkdir(path.join(root, "pages"));
      await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
      await Promise.all([
        fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" })),
        fs.writeFile(
          path.join(root, "app/layout.tsx"),
          "export const revalidate = 60; export default function Layout({children}) { return <html><body>{children}</body></html> }",
        ),
        fs.writeFile(
          path.join(root, "app/page.tsx"),
          '"use client"; import {useState} from "react"; export default function Page() { const [count, setCount] = useState(0); return <button onClick={() => setCount(count + 1)}>Count: {count}</button> }',
        ),
        fs.writeFile(
          path.join(root, "app/pending/page.tsx"),
          '"use client"; export default function Page() { if (typeof window !== "undefined") { window.__pendingAttempted = true; if (window.__holdDestination) throw (window.__destinationWait ??= new Promise(() => {})); } return <h1>Pending</h1> }',
        ),
        fs.writeFile(
          path.join(root, "pages/away.tsx"),
          "export default function Page() { return <h1>Away</h1> }",
        ),
      ]);
      const vinext = (await import("../../../packages/vinext/src/index.js")).default;
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [vinext({ appDir: root })],
        logLevel: "silent",
      });
      await builder.buildApp();
      // Chrome rejects BFCache after a no-store Flight fetch. Produce the
      // normal cacheable production artifacts for these static fixture routes.
      const { runPrerender } = await import(
        pathToFileURL(path.resolve("packages/vinext/dist/build/run-prerender.js")).href
      );
      await runPrerender({ root });
      server = await startChildProductionServer(root);
      const url = `http://127.0.0.1:${server.port}`;
      await page.goto(url);
      await waitForAppRouterHydration(page);
      await page.getByRole("button").click();
      await expect(page.getByRole("button")).toHaveText("Count: 1");
      await page.evaluate(() => {
        const probe = window as RestoreProbe;
        probe.__documentRestored = false;
        window.addEventListener("pageshow", (event) => {
          probe.__documentRestored = event.persisted;
        });
      });
      if (scenario.endsWith("Flight")) {
        await page.evaluate((fail) => {
          const probe = window as RestoreProbe;
          const fetch = window.fetch;
          window.fetch = async (...args) => {
            const response = await fetch(...args);
            if (new URL(response.url).pathname !== "/pending") return response;
            // Finish the network request so the document remains BFCache eligible,
            // but hold delivery to the router across departure and restoration.
            const held = new Response(await response.arrayBuffer(), {
              status: response.status,
              headers: response.headers,
            });
            Object.defineProperty(held, "url", { value: response.url });
            return new Promise<Response>((resolve, reject) => {
              probe.__releaseFlight = () =>
                fail ? reject(new Error("Late Flight failure")) : resolve(held);
            });
          };
          void window.next!.router!.push("/pending");
        }, scenario === "failed Flight");
        await expect
          .poll(() => page.evaluate(() => !!(window as RestoreProbe).__releaseFlight))
          .toBe(true);
      } else if (scenario === "accepted destination") {
        await page.evaluate(() => {
          (window as RestoreProbe).__holdDestination = true;
          void window.next!.router!.push("/pending");
        });
        await expect
          .poll(() => page.evaluate(() => (window as RestoreProbe).__pendingAttempted))
          .toBe(true);
        await expect(page.getByRole("button")).toHaveText("Count: 1");
      }
      await page.evaluate((useRouter) => {
        if (useRouter) void window.next!.router!.push("/away");
        else window.location.assign("/away");
      }, scenario === "departed Pages navigation");
      await expect(page).toHaveURL(`${url}/away`);
      await page.goBack({ waitUntil: "commit" });
      await expect
        .poll(() => page.evaluate(() => (window as RestoreProbe).__documentRestored))
        .toBe(true);
      await expect(page.getByRole("button")).toHaveText("Count: 1");
      if (scenario.endsWith("Flight")) {
        await page.evaluate(() => (window as RestoreProbe).__releaseFlight!());
        // Let the old continuation run before a fresh client update can replace it.
        await page.waitForTimeout(300);
        await expect(page).toHaveURL(`${url}/`);
      } else if (scenario === "accepted destination") {
        const refreshRequest = page.waitForRequest(
          (request) => request.method() === "GET" && request.headers().rsc === "1",
        );
        await page.evaluate(() => {
          (window as RestoreProbe).__holdDestination = false;
          const router = window.next!.router!;
          if (!("refresh" in router)) throw new Error("Expected the App Router");
          router.refresh();
        });
        expect(new URL((await refreshRequest).url()).pathname).toBe("/");
      }
      await page.getByRole("button").click();
      // A stale MPA render used to schedule another location change next frame.
      await page.waitForTimeout(300);
      await expect(page).toHaveURL(`${url}/`);
      await expect(page.getByRole("button")).toHaveText("Count: 2");
    } finally {
      await page.close();
      if (server) await stopChildProductionServer(server);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
