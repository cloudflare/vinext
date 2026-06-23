/**
 * SSR shell-error recovery in production builds.
 *
 * When the HTML (Fizz) render of an SSR pass rejects with an error that did
 * not originate in the RSC render (no `digest`), and the app has no custom
 * global-error.tsx, vinext serves the default `__next_error__` error-document
 * shell with the original flight payload and bootstrap module. The browser
 * detects the marker and re-renders the real tree with `createRoot` instead
 * of hydrating — Next.js's shell-error recovery semantics:
 * https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/app-render/app-render.tsx
 *
 * The throw-during-SSR-only pattern ("Expected error to opt out of server
 * rendering") comes from the Next.js `next-dynamic-css` fixture:
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
 *
 * This fixture intentionally has NO custom global-error.tsx — that is the
 * configuration in which handleSsr's error-document fallback is active
 * (`fallbackToErrorDocumentOnShellError`). Apps with a custom global-error
 * keep the server-rendered boundary re-render path, covered by
 * tests/nextjs-compat/global-error.test.ts.
 */
import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "../../fixtures";

type ProductionApp = {
  baseUrl: string;
  fixtureRoot: string;
  server: Server;
};

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const sourceNodeModules = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
  const targetNodeModules = path.join(fixtureRoot, "node_modules");

  await fs.mkdir(targetNodeModules, { recursive: true });

  for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".vite" || entry.name === ".vite-temp") continue;

    await fs.symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
}

async function writeRecoveryFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");
  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "public"), { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);

  // Minimal valid .ico so browser favicon requests do not 404 (the console
  // error fixture is strict).
  await fs.writeFile(
    path.join(fixtureRoot, "public/favicon.ico"),
    new Uint8Array([
      0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 48, 0, 0, 0, 22, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0,
      2, 0, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 255, 255, 255, 0,
    ]),
  );

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `import { ReactNode } from "react";

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
`,
  );

  // No local boundary: an SSR-only client throw rejects the HTML shell and the
  // default __next_error__ document recovery re-renders the real tree in the
  // browser. `cookies()` keeps the page dynamic so the runtime SSR pass (not a
  // prerendered document) serves the request.
  const pageDir = path.join(appDir, "page");
  await fs.mkdir(pageDir, { recursive: true });
  await fs.writeFile(
    path.join(pageDir, "page.tsx"),
    `import React from "react";
import { cookies } from "next/headers";
import Client from "./Client";

export default async function Page() {
  await cookies();
  return (
    <>
      <p id="server-content">Hello Server</p>
      <Client />
    </>
  );
}
`,
  );
  await fs.writeFile(
    path.join(pageDir, "Client.tsx"),
    `"use client";
import React from "react";

export default function Client() {
  if (typeof window === "undefined") {
    throw new Error("Expected error to opt out of server rendering");
  }
  return <p id="client-content">Hello Client</p>;
}
`,
  );

  // Genuine RSC/server error with no custom global-error.tsx. It also uses an
  // __next_error__ document, but must retain the pre-existing hydration path
  // rather than being mistaken for the marked SSR shell-recovery document.
  const serverErrorDir = path.join(appDir, "server-error");
  await fs.mkdir(serverErrorDir, { recursive: true });
  await fs.writeFile(
    path.join(serverErrorDir, "page.tsx"),
    `export default function ServerErrorPage(): never {
  throw new Error("genuine server digest error");
}
`,
  );

  // Local error.tsx routes: the shell fallback must not swallow local
  // boundary semantics. Local boundaries for shell errors materialize
  // client-side from the flight payload (Next.js parity):
  // - /boundary-ssr-only: the SSR render error remains represented in the
  //   initial tree, so the local boundary handles it after client rendering.
  // - /boundary-always: the browser re-render throws again and React catches
  //   it in the local error.tsx delivered in the flight payload.
  const boundarySsrOnlyDir = path.join(appDir, "boundary-ssr-only");
  const boundaryAlwaysDir = path.join(appDir, "boundary-always");
  await fs.mkdir(boundarySsrOnlyDir, { recursive: true });
  await fs.mkdir(boundaryAlwaysDir, { recursive: true });

  const localErrorBoundary = `"use client";
import React from "react";
export default function LocalError() {
  return <p id="local-error-boundary">Local boundary caught it</p>;
}
`;

  await fs.writeFile(
    path.join(boundarySsrOnlyDir, "page.tsx"),
    `import React from "react";
import { cookies } from "next/headers";
import Client from "./Client";
export default async function BoundarySsrOnlyPage() {
  await cookies();
  return <Client />;
}
`,
  );
  await fs.writeFile(
    path.join(boundarySsrOnlyDir, "Client.tsx"),
    `"use client";
import React from "react";
export default function Client() {
  if (typeof window === "undefined") {
    throw new Error("ssr-only boundary throw");
  }
  return <p id="boundary-ssr-only-content">Recovered client render</p>;
}
`,
  );
  await fs.writeFile(path.join(boundarySsrOnlyDir, "error.tsx"), localErrorBoundary);

  await fs.writeFile(
    path.join(boundaryAlwaysDir, "page.tsx"),
    `import React from "react";
import { cookies } from "next/headers";
import Client from "./Client";
export default async function BoundaryAlwaysPage() {
  await cookies();
  return <Client />;
}
`,
  );
  await fs.writeFile(
    path.join(boundaryAlwaysDir, "Client.tsx"),
    `"use client";
import React from "react";
export default function Client(): React.ReactNode {
  throw new Error("always boundary throw");
}
`,
  );
  await fs.writeFile(path.join(boundaryAlwaysDir, "error.tsx"), localErrorBoundary);

  // Ported from Next.js default global-error client runtime semantics:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/errors/index.test.ts
  // Combined with the SSR shell-recovery entry path exercised by:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
  const noBoundaryAlwaysDir = path.join(appDir, "no-boundary-always");
  await fs.mkdir(noBoundaryAlwaysDir, { recursive: true });
  await fs.writeFile(
    path.join(noBoundaryAlwaysDir, "page.tsx"),
    `import React from "react";
import { cookies } from "next/headers";
import Client from "./Client";
export default async function NoBoundaryAlwaysPage() {
  await cookies();
  return <Client />;
}
`,
  );
  await fs.writeFile(
    path.join(noBoundaryAlwaysDir, "Client.tsx"),
    `"use client";
import React from "react";
export default function Client(): React.ReactNode {
  throw new Error("always no boundary throw");
}
`,
  );

  // Ported from Next.js:
  // test/e2e/app-dir/default-error-page-ui/default-error-page-ui.test.ts
  // The built-in Reload button is an empty GET form. Browsers request the
  // current path with a trailing `?`; the App Router must canonicalize that
  // back to the query-less URL after the document reloads.
  const reloadDir = path.join(appDir, "reload-error");
  await fs.mkdir(reloadDir, { recursive: true });
  await fs.writeFile(
    path.join(reloadDir, "page.tsx"),
    `import React from "react";
import Client from "./Client";

export default function ReloadErrorPage() {
  return (
    <>
      <h1>Reload Error Page</h1>
      <Client />
    </>
  );
}
`,
  );
  await fs.writeFile(
    path.join(reloadDir, "Client.tsx"),
    `"use client";
import React, { useState } from "react";

export default function Client() {
  const [shouldThrow, setShouldThrow] = useState(false);
  if (shouldThrow) throw new Error("reload error");
  return <button id="trigger-reload-error" onClick={() => setShouldThrow(true)}>Trigger</button>;
}
`,
  );

  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  await fs.writeFile(
    path.join(fixtureRoot, "vite.config.ts"),
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
});
`,
  );
}

async function buildPrerenderAndServeRecoveryFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ssr-error-recovery-"));
  await writeRecoveryFixture(fixtureRoot);

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();

  const { runPrerender } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/build/run-prerender.js")).href
  );
  await runPrerender({ root: fixtureRoot });

  const { startProdServer } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
  );
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });

  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    fixtureRoot,
    server: started.server,
  };
}

test.setTimeout(90_000);

test.describe("SSR shell-error recovery (no custom global-error.tsx)", () => {
  test("recovers the real tree in the browser and preserves local error.tsx semantics", async ({
    page,
    consoleErrors,
  }) => {
    const app = await buildPrerenderAndServeRecoveryFixture();

    try {
      // SSR-only client throw without a boundary: the default __next_error__
      // shell is served and the browser re-renders the real tree from the
      // embedded flight payload.
      await page.goto(`${app.baseUrl}/page`, { waitUntil: "load" });
      await expect(page.locator("#server-content")).toHaveText("Hello Server");
      await expect(page.locator("#client-content")).toHaveText("Hello Client");

      // A genuine server/RSC error also uses the default __next_error__
      // document and follows Next.js's createRoot recovery path. Unlike the
      // SSR-only recovery shell, it has no placeholder style marker to remove.
      await page.goto(`${app.baseUrl}/server-error`, { waitUntil: "load" });
      await expect(page.getByRole("heading", { name: "This page couldn’t load" })).toBeVisible();
      await expect(page.getByText("Reload to try again, or go back.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
      await expect(page.locator("style[data-vinext-error-shell-style]")).toHaveCount(0);

      // SSR-only throw with a local error.tsx: the error remains represented
      // in the initial tree and the local boundary provides the visible UX.
      await page.goto(`${app.baseUrl}/boundary-ssr-only`, { waitUntil: "load" });
      await expect(page.locator("#local-error-boundary")).toHaveText("Local boundary caught it");
      await expect(page.locator("#boundary-ssr-only-content")).toHaveCount(0);

      // Unconditional client throw: the browser re-render throws again and the
      // local error.tsx from the flight payload catches it.
      await page.goto(`${app.baseUrl}/boundary-always`, { waitUntil: "load" });
      await expect(page.locator("#local-error-boundary")).toHaveText("Local boundary caught it");

      // No local boundary: the shell recovery still re-renders on the client,
      // but the root default global-error boundary must catch the repeated
      // throw instead of leaving a blank torn-down document.
      await page.goto(`${app.baseUrl}/no-boundary-always`, { waitUntil: "load" });
      await expect(page.getByRole("heading", { name: "This page couldn’t load" })).toBeVisible();
      await expect(page.getByText("Reload to try again, or go back.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Back" })).toBeVisible();

      await page.goto(`${app.baseUrl}/reload-error`, { waitUntil: "load" });
      await page.locator("#trigger-reload-error").click();
      await expect(page.getByRole("heading", { name: "This page couldn’t load" })).toBeVisible();
      const urlBeforeReload = page.url();
      await page.getByRole("button", { name: "Reload" }).click();
      await expect(page.getByRole("heading", { name: "Reload Error Page" })).toBeVisible();
      expect(page.url()).toBe(urlBeforeReload);

      // The boundary routes throw on purpose, and React logs caught boundary
      // errors to the console. Drop those expected entries but stay strict
      // about anything else; the fixture re-asserts emptiness at teardown.
      const unexpectedErrors = consoleErrors.filter(
        (message) =>
          !message.includes("boundary throw") &&
          !message.includes("always no boundary throw") &&
          !message.includes("reload error") &&
          !message.includes("genuine server digest error") &&
          !message.includes("Expected error to opt out of server rendering") &&
          // The recovery and global-error documents intentionally preserve
          // their HTTP 500 status, which browsers report as a resource error.
          !message.includes("Failed to load resource: the server responded with a status of 500") &&
          // React's companion log for an error caught by a boundary.
          !message.startsWith("The above error occurred in a React component"),
      );
      expect(unexpectedErrors).toEqual([]);
      consoleErrors.length = 0;
    } finally {
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });
});
