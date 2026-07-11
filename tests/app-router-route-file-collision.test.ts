import fs from "node:fs/promises";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-route-file-collision");

describe("App Router route and project file collisions", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-route-file-collision-");
    ({ server, baseUrl } = await startFixtureServer(fixtureDir));
  }, 30000);

  afterAll(async () => {
    await server?.close();
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it("does not let a custom page extension shadow an HTML route request", async () => {
    const response = await fetch(`${baseUrl}/agents`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Agents route response");
    expect(body).not.toContain("root-agents-markdown");
  });

  it("does not let a custom page extension shadow an RSC route request", async () => {
    const headers = createRscRequestHeaders();
    const requestUrl = await createRscRequestUrl("/agents", headers);
    const response = await fetch(`${baseUrl}${requestUrl}`, {
      headers,
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-component");
    expect(body).toContain("Agents route response");
    expect(body).not.toContain("root-agents-markdown");
  });

  it("still serves routes discovered through a custom page extension", async () => {
    const headers = createRscRequestHeaders();
    const requestUrl = await createRscRequestUrl("/custom-extension", headers);
    const response = await fetch(`${baseUrl}${requestUrl}`, {
      headers,
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-component");
    expect(body).toContain("Custom MDX route response");
  });

  it("preserves the default extensionless module resolution priority", async () => {
    // Next.js Turbopack prefers .tsx over .js by default.
    // https://github.com/vercel/next.js/blob/canary/turbopack/crates/turbopack-resolve/src/resolve.rs
    const headers = createRscRequestHeaders();
    const requestUrl = await createRscRequestUrl("/default-priority", headers);
    const response = await fetch(`${baseUrl}${requestUrl}`, {
      headers,
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-component");
    expect(body).toContain("TypeScript module response");
    expect(body).not.toContain("JavaScript module response");
  });
});
