import { test, expect, type APIRequestContext } from "@playwright/test";
import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = "http://localhost:4181";
const FIXTURE_ROOT = path.join(process.cwd(), "tests/fixtures/app-with-src");
// Matches Vite's default server.fs.deny `.env.*` glob, and is not loaded as an
// env file in development mode. Its content parses as JavaScript, so a server
// environment transform would produce a source map for it.
const DENIED_FILE_NAME = ".env.original-stack-trace-probe";
const DENIED_FILE = path.join(FIXTURE_ROOT, DENIED_FILE_NAME);
const DENIED_SECRET = "original-stack-trace-probe-secret";
// An allowed-looking in-root name whose real path is the denied file.
const DENIED_FILE_LINK = path.join(FIXTURE_ROOT, "original-stack-trace-probe-link.js");

async function resolveOriginalStackTrace(request: APIRequestContext, frameLocation: string) {
  // No Origin header, like a non-browser client on the network.
  const response = await request.post(`${BASE}/__vinext_original-stack-trace`, {
    data: JSON.stringify({ stack: `Error: probe\n    at probe (${frameLocation})` }),
    headers: { "Content-Type": "text/plain" },
  });
  expect(response.status()).toBe(200);
  return {
    body: await response.text(),
    json: (await response.json()) as { stack: string; codeFrame?: unknown },
  };
}

// The dev stack-trace endpoint must only map frames for files Vite itself would
// serve. Next.js builds stack-frame code frames from source-map sourcesContent
// and never returns raw file contents for a requested frame path:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/dev/middleware-webpack.ts
test.describe("original stack trace endpoint file access", () => {
  test.beforeAll(async () => {
    await writeFile(DENIED_FILE, `API_KEY = "${DENIED_SECRET}";\n`);
    await rm(DENIED_FILE_LINK, { force: true });
    await symlink(DENIED_FILE, DENIED_FILE_LINK);
  });

  test.afterAll(async () => {
    await rm(DENIED_FILE_LINK, { force: true });
    await rm(DENIED_FILE, { force: true });
  });

  test("does not disclose files denied by server.fs.deny", async ({ request }) => {
    const served = await request.get(`${BASE}/${DENIED_FILE_NAME}`);
    expect(served.status()).toBe(403);

    for (const frameFile of [
      DENIED_FILE,
      `${FIXTURE_ROOT}/src/../${DENIED_FILE_NAME}`,
      pathToFileURL(DENIED_FILE).href,
      DENIED_FILE_LINK,
    ]) {
      const { body, json } = await resolveOriginalStackTrace(request, `${frameFile}:1:1`);
      expect(body).not.toContain(DENIED_SECRET);
      expect(json.codeFrame).toBeUndefined();
      expect(json.stack).toBe(`Error: probe\n    at probe (${frameFile}:1:1)`);
    }
  });

  test("still maps frames for project source files", async ({ request }) => {
    const pageFile = path.join(FIXTURE_ROOT, "src/app/page.tsx");
    // Generated line 2 maps back into the page's original import lines.
    const { json } = await resolveOriginalStackTrace(request, `${pageFile}:2:1`);
    expect(json.stack).toContain(pathToFileURL(pageFile).href);
    expect(json.codeFrame).toMatchObject({
      file: pathToFileURL(pageFile).href,
      lines: expect.arrayContaining([
        expect.objectContaining({ text: 'import Link from "next/link";' }),
      ]),
    });
  });
});
