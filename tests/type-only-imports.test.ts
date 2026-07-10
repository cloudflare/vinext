/**
 * Test: inline type-only import specifier elision
 *
 * Next.js (SWC) fully elides `import { type Metadata } from "next"` — the
 * whole statement is removed because every specifier is type-only. esbuild
 * and tsc (without `verbatimModuleSyntax`) behave the same way.
 *
 * Vite 8's OXC transform reads the project tsconfig; when it contains
 * `"verbatimModuleSyntax": true` (emitted stock by create-t3-app and other
 * scaffolds), OXC switches to `onlyRemoveTypeImports` semantics and leaves a
 * side-effect `import "next"` behind. That pulls the real Next.js server
 * runtime into the RSC graph (dev 500s, build failures) and — worse — pulls
 * server-only modules into the client bundle when a `"use client"` file uses
 * `import { type X } from "~/server/..."`.
 *
 * vinext forces `typescript.onlyRemoveTypeImports: false` so elision matches
 * Next.js regardless of the app's tsconfig.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import path from "node:path";
import { startFixtureServer, fetchHtml } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-type-only-imports");

describe("inline type-only import elision (verbatimModuleSyntax tsconfig)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("should not leave a runtime import of 'next' when all specifiers are type-only", async () => {
    const rsc = server.environments["rsc"];
    expect(rsc).toBeDefined();
    const result = await rsc!.transformRequest("/app/layout.tsx");
    expect(result).not.toBeNull();
    // A surviving side-effect `import "next"` resolves to the real Next.js
    // package and drags its server runtime into the RSC graph. In the dev
    // module runner the import is rewritten to a `__vite_ssr_import__` of
    // the resolved `.../node_modules/next/dist/server/next.js` path, so
    // assert no reference to the real package (or a bare "next" id) remains.
    expect(result!.code).not.toMatch(/["'][^"']*\/next\/dist\//);
    expect(result!.code).not.toMatch(/["']next["']/);
  });

  it("should keep value specifiers in mixed value + type imports", async () => {
    const client = server.environments["client"];
    expect(client).toBeDefined();
    const result = await client!.transformRequest("/app/client-widget.tsx");
    expect(result).not.toBeNull();
    expect(result!.code).toContain("useState");
  });

  it("should not pull a server module into the client graph via a type-only import", async () => {
    const client = server.environments["client"];
    expect(client).toBeDefined();
    const result = await client!.transformRequest("/app/client-widget.tsx");
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain("server-data");
  });

  it("should serve the page successfully", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(html).toContain("Type Only Imports");
  });
});
