import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "../fixtures";
import { waitForHydration } from "../helpers";

type AppPropsRecord = {
  hasPageProps: boolean;
  pathname: string;
};

const fixtureDir = path.resolve(process.cwd(), "tests/fixtures/pages-app-props");
const cliPath = path.resolve(process.cwd(), "packages/vinext/dist/cli.js");
const execFileAsync = promisify(execFile);

let devProcess: ChildProcess;
let devUrl: string;
let prodProcess: ChildProcess;
let prodUrl: string;

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForServer(child: ChildProcess, url: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Fixture server exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${url}/missing`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

async function latestAppPropsRecord(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const records = (window as any).__APP_PROPS_RECORDS__ as AppPropsRecord[] | undefined;
    return records?.at(-1);
  });
}

test.setTimeout(120_000);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await fs.rm(path.join(fixtureDir, "dist"), { recursive: true, force: true });
  await execFileAsync(process.execPath, [cliPath, "build"], {
    cwd: fixtureDir,
    env: { ...process.env, NODE_ENV: "production" },
  });

  const [devPort, prodPort] = await Promise.all([getAvailablePort(), getAvailablePort()]);
  devUrl = `http://127.0.0.1:${devPort}`;
  prodUrl = `http://127.0.0.1:${prodPort}`;
  devProcess = spawn(
    "npx",
    ["vp", "dev", "--force", "--host", "127.0.0.1", "--port", String(devPort)],
    {
      cwd: fixtureDir,
      stdio: "inherit",
    },
  );
  prodProcess = spawn(
    process.execPath,
    [cliPath, "start", "--host", "127.0.0.1", "--port", String(prodPort)],
    {
      cwd: fixtureDir,
      stdio: "inherit",
    },
  );
  await Promise.all([waitForServer(devProcess, devUrl), waitForServer(prodProcess, prodUrl)]);
});

test.afterAll(async () => {
  await Promise.all([stopServer(devProcess), stopServer(prodProcess)]);
  await fs.rm(path.join(fixtureDir, "dist"), { recursive: true, force: true });
});

for (const mode of ["development", "production"] as const) {
  test(`matches custom App own pageProps semantics through ${mode} hydration and navigation`, async ({
    page,
    consoleErrors: _consoleErrors,
  }) => {
    const baseUrl = mode === "development" ? devUrl : prodUrl;

    // SSR must preserve the exact object returned by App.getInitialProps.
    const response = await fetch(`${baseUrl}/missing`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="has-page-props">false</div>');

    await page.goto(`${baseUrl}/missing`);
    await waitForHydration(page);
    await expect(page.locator("#has-page-props")).toHaveText("false");
    await expect
      .poll(() => latestAppPropsRecord(page))
      .toEqual({ pathname: "/missing", hasPageProps: false });
    const bootMarker = await page.evaluate(() => {
      const marker = crypto.randomUUID();
      (window as any).__APP_PROPS_BOOT_MARKER__ = marker;
      return marker;
    });

    await page.locator("#to-with-page-props").click();
    await expect(page).toHaveURL(`${baseUrl}/with-page-props`);
    await expect(page.locator("#has-page-props")).toHaveText("true");
    await expect(page.locator("#page-content")).toHaveText("from-app");
    await expect
      .poll(() => latestAppPropsRecord(page))
      .toEqual({ pathname: "/with-page-props", hasPageProps: true });

    // Next.js clones pageProps with Object.assign on successful transitions.
    // That turns null into {} and a string into an object with indexed keys.
    await page.locator("#to-null-page-props").click();
    await expect(page).toHaveURL(`${baseUrl}/null-page-props`);
    await expect(page.locator("#page-props-json")).toHaveText("{}");
    await page.locator("#to-string-page-props").click();
    await expect(page).toHaveURL(`${baseUrl}/string-page-props`);
    await expect(page.locator("#page-props-json")).toHaveText('{"0":"h","1":"i"}');

    // A page-level getInitialProps remains wrapped in pageProps by App.getInitialProps.
    await page.locator("#to-page-gip").click();
    await expect(page).toHaveURL(`${baseUrl}/page-gip`);
    await expect(page.locator("#has-page-props")).toHaveText("true");
    await expect(page.locator("#page-content")).toHaveText("from-page");

    // Next.js merges data props with Object.assign({}, appPageProps, dataProps).
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx
    await page.locator("#to-gsp-string").click();
    await expect(page).toHaveURL(`${baseUrl}/gsp-string`);
    await expect(page.locator("#page-props-json")).toHaveText('{"0":"h","1":"i","fromData":"gsp"}');
    await expect(page.locator("#app-router-pathname")).toHaveText("/gsp-string");
    await page.locator("#to-gssp-array").click();
    await expect(page).toHaveURL(`${baseUrl}/gssp-array`);
    await expect(page.locator("#page-props-json")).toHaveText(
      '{"0":"first","1":"second","fromData":"gssp"}',
    );

    // Navigate back to another omitted-pageProps result. The unchanged initial
    // document marker proves these transitions stayed in the client router.
    await page.locator("#to-missing-two").click();
    await expect(page).toHaveURL(`${baseUrl}/missing-two`);
    expect(await page.evaluate(() => (window as any).__APP_PROPS_BOOT_MARKER__)).toBe(bootMarker);
    await expect(page.locator("#has-page-props")).toHaveText("true");
    await expect(page.locator("#page-props-json")).toHaveText("{}");
    await expect(page.locator("#page-content")).toHaveText("missing pageProps again");
    await expect
      .poll(() => latestAppPropsRecord(page))
      .toEqual({ pathname: "/missing-two", hasPageProps: true });
  });
}
