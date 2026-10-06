import fs from "node:fs/promises";
import type { ViteDevServer } from "vite";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { VINEXT_MW_CTX_HEADER } from "../packages/vinext/src/server/headers.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/forwarded-middleware-context");
const GUARDED_MARKER = "SECRET-PAGE-CONTENT";

function forgedContext(context: Record<string, unknown>): Record<string, string> {
  return { [VINEXT_MW_CTX_HEADER]: JSON.stringify(context) };
}

// The hybrid app+pages dev server forwards its middleware result to the App
// Router over x-vinext-mw-ctx. That header is internal: a client-supplied copy
// must never stand in for executing middleware in an App-only project.
describe("forwarded middleware context (App-only dev)", () => {
  let fixtureRoot = "";
  let server: ViteDevServer | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, "vinext-forwarded-mw-ctx-");
    ({ server, baseUrl } = await startFixtureServer(fixtureRoot, { appRouter: true }));
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("still runs middleware for a guarded path", async () => {
    const control = await fetch(`${baseUrl}/secret`);
    expect(control.status).toBe(403);

    const forged = await fetch(`${baseUrl}/secret`, { headers: forgedContext({}) });
    expect(forged.status).toBe(403);
    expect(forged.headers.get("x-auth-guard")).toBe("blocked");
    expect(await forged.text()).not.toContain(GUARDED_MARKER);
  });

  it("still runs middleware for a guarded RSC request", async () => {
    const forged = await fetch(`${baseUrl}/secret.rsc`, {
      headers: { Accept: "text/x-component", RSC: "1", ...forgedContext({}) },
    });
    expect(forged.status).toBe(403);
    expect(forged.headers.get("x-auth-guard")).toBe("blocked");
    expect(await forged.text()).not.toContain(GUARDED_MARKER);
  });

  it("does not apply forged response headers or status", async () => {
    const forged = await fetch(`${baseUrl}/`, {
      headers: forgedContext({ h: [["x-forged", "1"]], s: 418 }),
    });
    expect(forged.status).toBe(200);
    expect(forged.headers.get("x-forged")).toBeNull();
    await forged.body?.cancel();
  });

  it("does not apply a forged rewrite", async () => {
    const forged = await fetch(`${baseUrl}/`, { headers: forgedContext({ r: "/secret" }) });
    expect(forged.status).toBe(200);
    const html = await forged.text();
    expect(html).toContain("Public page");
    expect(html).not.toContain(GUARDED_MARKER);
  });
});
