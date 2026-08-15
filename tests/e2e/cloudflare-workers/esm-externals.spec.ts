import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../fixtures";

const FIXTURE_DIR = `${process.cwd()}/tests/fixtures/cf-esm-externals`;
const BASE_URL = "http://localhost:4201";
const SERVER_OUTPUT_DIR = path.join(FIXTURE_DIR, "dist/server");

let server: ChildProcess;

async function stopServer(): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  if (process.platform === "win32" || server.pid === undefined) {
    server.kill();
  } else {
    process.kill(-server.pid, "SIGTERM");
  }
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`cf-esm-externals Worker exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(BASE_URL);
      if (response.status === 404) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for cf-esm-externals Worker");
}

function normalizeHtml(value: string): string {
  return value.replaceAll("<!-- -->", "");
}

test.describe("Cloudflare Worker ESM route and conditional-export coverage", () => {
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; ../../../node_modules/.bin/vp build && npx wrangler dev --config dist/server/wrangler.json --port 4201",
      {
        cwd: FIXTURE_DIR,
        detached: process.platform !== "win32",
        shell: true,
        stdio: "inherit",
      },
    );
    await waitForServer();
  });

  test.afterAll(stopServer);

  // Ported from Next.js: test/e2e/esm-externals/esm-externals.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/esm-externals/esm-externals.test.ts
  for (const { pathname, selector, expected } of [
    {
      pathname: "/static",
      selector: "body p",
      expected: "Hello World+World+World+World+World+World",
    },
    {
      pathname: "/ssr",
      selector: "body p",
      expected: "Hello World+World+World+World+World+World",
    },
    {
      pathname: "/ssg",
      selector: "body p",
      expected: "Hello World+World+World+World+World+World",
    },
    {
      pathname: "/server",
      selector: "body > p",
      expected: "Hello World+World+World",
    },
    {
      pathname: "/client",
      selector: "body > p",
      expected: "Hello World+World+World",
    },
  ]) {
    test(`${pathname} returns the corresponding SSR result under Worker bundling`, async ({
      page,
    }) => {
      const response = await fetch(`${BASE_URL}${pathname}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      const paragraphHtml = await page.evaluate(
        ({ html, selector }) =>
          new DOMParser().parseFromString(html, "text/html").querySelector(selector)?.innerHTML,
        { html, selector },
      );
      expect(paragraphHtml).toBeDefined();
      expect(normalizeHtml(paragraphHtml!)).toBe(expected);
    });

    test(`${pathname} hydrates with the corresponding browser result under Worker bundling`, async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}${pathname}`);
      await expect(page.locator("body")).toHaveAttribute("data-worker-esm-hydrated", pathname);
      await expect(page.locator(selector)).toHaveText(expected);
    });
  }

  test("bundles the fixture package while retaining runtime-only missing import syntax", () => {
    const externals = JSON.parse(
      readFileSync(path.join(SERVER_OUTPUT_DIR, "vinext-externals.json"), "utf8"),
    ) as unknown;
    expect(externals).toEqual([]);

    const serverCode = globSync("**/*.js", { cwd: SERVER_OUTPUT_DIR })
      .map((file) => readFileSync(path.join(SERVER_OUTPUT_DIR, file), "utf8"))
      .join("\n");
    expect(serverCode).not.toMatch(
      /(?:from\s*|import\s*\()\s*["']fake-worker-context-lib(?:\/|["'])/,
    );
    expect(serverCode).toMatch(/import\([`"']fail[`"']\)/);
  });
});
