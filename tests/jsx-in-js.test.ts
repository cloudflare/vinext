/**
 * Test: JSX in plain .js files
 *
 * Next.js allows JSX syntax in .js files (Babel/SWC handle it transparently).
 * Vite 8's OXC transform defaults exclude .js files (include: /\.(m?ts|[jt]sx)$/,
 * exclude: /\.js$/). vinext overrides these defaults to match Next.js behavior.
 *
 * Without the fix, .js files containing JSX would fail with:
 *   "Unexpected JSX expression" (OXC parse error)
 */

import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { Plugin, ViteDevServer } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "./helpers.js";

describe("JSX in plain .js files", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("should render a page component defined in a .js file with JSX", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/jsx-in-js");
    expect(res.status).toBe(200);
    expect(html).toContain("Hello JSX in JS");
    expect(html).toContain("jsx-in-js");
  });

  it("should not produce 'Unexpected JSX expression' errors for .js files", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/jsx-in-js");
    // If OXC fails to parse JSX in .js, the response would contain an error message
    expect(html).not.toContain("Unexpected");
    expect(html).not.toContain("PARSE_ERROR");
    expect(res.status).toBe(200);
  });
});

describe("vinext:jsx-in-js transform", () => {
  it("reuses the transform for the same id and source", async () => {
    const plugin = (vinext() as Plugin[])
      .flat(Infinity)
      .find((candidate) => candidate.name === "vinext:jsx-in-js");
    expect(plugin).toBeDefined();
    const transform = plugin!.transform as {
      handler(code: string, id: string): Promise<{ code: string } | undefined>;
    };

    const id = path.join(os.tmpdir(), "vinext-jsx-in-js", "component.js");
    const source = "export default function Component() { return <p>first</p>; }";
    const first = await transform.handler(source, id);
    expect(first?.code).toContain("jsx(");
    // Every environment and scan/build pass transforms the same module.
    expect(await transform.handler(source, id)).toBe(first);

    const changed = await transform.handler(source.replace("first", "second"), id);
    expect(changed).not.toBe(first);
    expect(changed?.code).toContain("second");

    const otherId = path.join(os.tmpdir(), "vinext-jsx-in-js", "other.js");
    expect(await transform.handler(source, otherId)).not.toBe(first);
  });
});
