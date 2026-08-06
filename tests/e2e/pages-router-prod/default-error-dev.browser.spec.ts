import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ViteDevServer } from "vite";
import { test as base, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

type DevelopmentApp = {
  baseUrl: string;
};

async function createDevelopmentFixture(): Promise<{
  fixtureRoot: string;
  server: ViteDevServer;
  app: DevelopmentApp;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-default-error-dev-"));
  const pagesDir = path.join(fixtureRoot, "pages");

  await fs.symlink(
    path.resolve(process.cwd(), "tests/fixtures/pages-basic/node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(
    path.join(pagesDir, "_app.tsx"),
    `import { useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useRouter } from "next/router";

export default function App({ Component, pageProps, customEnvelope, router }) {
  const [hydrated, setHydrated] = useState(false);
  const contextRouter = useRouter();
  useEffect(() => setHydrated(true), []);

  return (
    <main
      data-testid="custom-app"
      data-envelope={customEnvelope}
      data-hydrated={hydrated}
      data-has-router={Boolean(router)}
      data-router-pathname={router?.pathname}
      data-router-ready={String(router?.isReady)}
      data-context-pathname={contextRouter.pathname}
      data-context-as-path={contextRouter.asPath}
      data-context-ready={String(contextRouter.isReady)}
    >
      <Component {...pageProps} />
    </main>
  );
}

App.getInitialProps = async ({ AppTree, ctx, router }) => {
  if (ctx.asPath === "/missing-a") await new Promise((resolve) => setTimeout(resolve, 50));
  const appTreeHtml = renderToStaticMarkup(<AppTree pageProps={{}} />);
  const appTreeHasRouter = appTreeHtml.includes('data-router-pathname="/_error"')
    && appTreeHtml.includes('data-context-as-path="' + ctx.asPath + '"');
  return {
    customEnvelope: router.route === "/_error" && router.isReady === true && appTreeHasRouter
      ? "preserved"
      : "broken",
  };
};
`,
  );
  await fs.writeFile(
    path.join(pagesDir, "index.tsx"),
    `export default function Home() { return <main>Home</main>; }\n`,
  );

  const configFile = path.join(fixtureRoot, "vite.config.ts");
  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  await fs.writeFile(
    configFile,
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({
  plugins: [vinext()],
});
`,
  );

  const { createServer } = await import("vite");
  const server = await createServer({
    root: fixtureRoot,
    configFile,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();

  const baseUrl = server.resolvedUrls?.local[0];
  if (!baseUrl) {
    await server.close();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    throw new Error("Vite dev server did not expose a local URL");
  }

  return { fixtureRoot, server, app: { baseUrl } };
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks -- Playwright fixture `use`, not a React hook */
const test = base.extend<{ developmentApp: DevelopmentApp }>({
  developmentApp: async ({ page }, use) => {
    const { fixtureRoot, server, app } = await createDevelopmentFixture();

    try {
      await use(app);
    } finally {
      await page.close();
      await server.close();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  },
});
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

test.setTimeout(30_000);

test.describe("Pages Router framework error page development fallback", () => {
  test("preserves a custom app envelope without pageProps", async ({
    page,
    developmentApp,
    consoleErrors,
  }) => {
    const response = await page.goto(`${developmentApp.baseUrl}missing?x=1`, {
      waitUntil: "load",
    });

    expect(response?.status()).toBe(404);
    await expect(page.locator("#__next h1")).toHaveCount(0);
    await expect(page.locator("#__next h2")).toHaveText(
      "Application error: a client-side exception has occurred (see the browser console for more information).",
    );
    await expect(page.getByTestId("custom-app")).toHaveAttribute("data-envelope", "preserved");
    await expect(page.getByTestId("custom-app")).toHaveAttribute("data-has-router", "true");
    await expect(page.getByTestId("custom-app")).toHaveAttribute("data-router-pathname", "/_error");
    await expect(page.getByTestId("custom-app")).toHaveAttribute("data-router-ready", "true");
    await expect(page.getByTestId("custom-app")).toHaveAttribute(
      "data-context-pathname",
      "/_error",
    );
    await expect(page.getByTestId("custom-app")).toHaveAttribute(
      "data-context-as-path",
      "/missing?x=1",
    );
    await expect(page.getByTestId("custom-app")).toHaveAttribute("data-context-ready", "true");
    await waitForHydration(page);
    await expect(page.getByTestId("custom-app")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("custom-app")).toHaveAttribute("data-router-ready", "true");
    await expect(page.getByTestId("custom-app")).toHaveAttribute("data-context-ready", "true");

    const nextData = await page.evaluate(() => window.__NEXT_DATA__);
    expect(nextData.props).toEqual({ customEnvelope: "preserved" });

    const unexpectedErrors = consoleErrors.filter(
      (message) =>
        !/^Failed to load resource: the server responded with a status of 404 \(.+\)$/.test(
          message,
        ),
    );
    expect(unexpectedErrors).toEqual([]);
    consoleErrors.length = 0;
  });

  test("isolates router context across concurrent missing routes", async ({ developmentApp }) => {
    const [first, second] = await Promise.all([
      fetch(`${developmentApp.baseUrl}missing-a`).then((response) => response.text()),
      fetch(`${developmentApp.baseUrl}missing-b`).then((response) => response.text()),
    ]);

    expect(first).toContain('data-context-as-path="/missing-a"');
    expect(second).toContain('data-context-as-path="/missing-b"');
    expect(first).toContain('data-envelope="preserved"');
    expect(second).toContain('data-envelope="preserved"');
  });
});
