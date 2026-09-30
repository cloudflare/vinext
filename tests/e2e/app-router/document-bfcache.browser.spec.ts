import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
test("a BFCache-restored App document does not retry its departed Pages navigation", async ({
  page,
}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-document-bfcache-"));
  let server: ChildProductionServer | undefined;
  try {
    await fs.mkdir(path.join(root, "app"));
    await fs.mkdir(path.join(root, "pages"));
    await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    await Promise.all([
      fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" })),
      fs.writeFile(
        path.join(root, "app/layout.tsx"),
        "export default function Layout({children}) { return <html><body>{children}</body></html> }",
      ),
      fs.writeFile(
        path.join(root, "app/page.tsx"),
        '"use client"; import {useState} from "react"; export default function Page() { const [count, setCount] = useState(0); return <button onClick={() => setCount(count + 1)}>Count: {count}</button> }',
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
    server = await startChildProductionServer(root);
    const url = `http://127.0.0.1:${server.port}`;
    await page.goto(url);
    await waitForAppRouterHydration(page);
    await page.getByRole("button").click();
    await expect(page.getByRole("button")).toHaveText("Count: 1");
    await page.evaluate(() => {
      const probe = window as typeof window & { __documentRestored?: boolean };
      probe.__documentRestored = false;
      window.addEventListener("pageshow", (event) => {
        probe.__documentRestored = event.persisted;
      });
      void window.next!.router!.push("/away");
    });
    await expect(page).toHaveURL(`${url}/away`);
    await page.goBack({ waitUntil: "commit" });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as typeof window & { __documentRestored?: boolean }).__documentRestored,
        ),
      )
      .toBe(true);
    await expect(page.getByRole("button")).toHaveText("Count: 1");
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
