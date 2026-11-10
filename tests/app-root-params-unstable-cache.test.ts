// Like Next.js's `unstable-cache` work unit: root params are not available in
// an unstable_cache() callback, or in a "use cache" function it calls.
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/request/root-params.ts

import fs from "node:fs";
import path from "node:path";
import { createBuilder, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-root-params-unstable-cache");

function decodeHtml(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("App Router root params inside unstable_cache", () => {
  let previewServer: Awaited<ReturnType<typeof preview>>;
  let baseUrl: string;

  beforeAll(async () => {
    const builder = await createBuilder({
      root: FIXTURE_DIR,
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      logLevel: "silent",
    });
    await builder.buildApp();

    previewServer = await preview({
      root: FIXTURE_DIR,
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      preview: { port: 0 },
      logLevel: "silent",
    });
    const address = previewServer.httpServer.address();
    baseUrl = address && typeof address === "object" ? `http://localhost:${address.port}` : "";
  }, 120_000);

  afterAll(() => {
    previewServer?.httpServer.close();
    fs.rmSync(path.join(FIXTURE_DIR, "dist"), { recursive: true, force: true });
  });

  async function render(pathname: string, headers?: Record<string, string>) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    const html = await response.text();
    const data = html.match(/<pre id="data">(.*?)<\/pre>/s)?.[1];
    const error = html.match(/<pre id="error">(.*?)<\/pre>/s)?.[1];
    return {
      status: response.status,
      data: data === undefined ? undefined : JSON.parse(decodeHtml(data)),
      error: error === undefined ? undefined : decodeHtml(error),
    };
  }

  it("rejects a root-param read in a use cache function called from unstable_cache", async () => {
    for (const tenant of ["b", "c"]) {
      const mixed = await render(`/${tenant}/mixed`);
      expect(mixed.data).toBeUndefined();
      expect(mixed.error).toContain(
        "`import('next/root-params').tenant()` was used inside `\"use cache\"` nested within `unstable_cache`.",
      );
    }
  });

  it("does not serve a root's use cache entry to unstable_cache", async () => {
    const direct = await render("/d/direct");
    expect(direct.data).toMatchObject({ tenant: "d" });

    for (const tenant of ["d", "e"]) {
      const mixed = await render(`/${tenant}/mixed`);
      expect(mixed.data).toBeUndefined();
      expect(mixed.error).toContain("nested within `unstable_cache`");
    }
  });

  it("keeps direct use cache calls partitioned by root", async () => {
    const a = await render("/a/direct");
    const b = await render("/b/direct");

    expect(a.data).toMatchObject({ tenant: "a" });
    expect(b.data).toMatchObject({ tenant: "b" });
    await expect(render("/a/direct")).resolves.toMatchObject({ data: a.data });
  });

  it("rejects a root-param read directly inside an unstable_cache callback", async () => {
    for (const tenant of ["b", "c"]) {
      await expect(render(`/${tenant}/callback`)).resolves.toEqual({
        status: 200,
        data: undefined,
        error:
          "`import('next/root-params').tenant()` was used inside `unstable_cache`. This is not supported. Use `\"use cache\"` instead.",
      });
    }
  });

  it("rejects a root-param read inside an unstable_cache callback in draft mode", async () => {
    const enable = await fetch(`${baseUrl}/api/draft`);
    const cookie = enable.headers.getSetCookie().map((value) => value.split(";")[0]);
    expect(cookie).toContainEqual(expect.stringMatching(/^__prerender_bypass=/));

    const draft = await render("/f/callback", { cookie: cookie.join("; ") });
    expect(draft.data).toBeUndefined();
    expect(draft.error).toContain("inside `unstable_cache`");
  });
});
