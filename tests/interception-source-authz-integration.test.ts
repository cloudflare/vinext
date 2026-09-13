import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/interception-source-authz");
const GUARDED_MARKER = "SECRET-FEED-CONTENT";

type StartedServer = {
  baseUrl: string;
  close(): Promise<void>;
};

function interceptionHeaders(source: string): Record<string, string> {
  return {
    Accept: "text/x-component",
    RSC: "1",
    "X-Vinext-Interception-Context": source,
  };
}

async function startDevServer(root: string): Promise<StartedServer> {
  const { server, baseUrl } = await startFixtureServer(root, { appRouter: true });
  return {
    baseUrl,
    close: () => server.close(),
  };
}

async function startProductionServer(root: string): Promise<StartedServer> {
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(root, "dist"),
    noCompression: true,
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Production server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function expectInterceptionSourceAuthorization(baseUrl: string): Promise<void> {
  const direct = await fetch(`${baseUrl}/feed/secret`);
  expect(direct.status).toBe(403);
  expect(direct.headers.get("x-auth-guard")).toBe("blocked");
  expect(await direct.text()).not.toContain(GUARDED_MARKER);

  const control = await fetch(`${baseUrl}/photos/1`, {
    headers: interceptionHeaders("/feed/secret"),
  });
  expect(control.status).toBe(403);
  expect(control.headers.get("x-auth-guard")).toBe("blocked");
  expect(await control.text()).not.toContain(GUARDED_MARKER);

  const traversal = await fetch(`${baseUrl}/photos/1`, {
    headers: interceptionHeaders("/feed/.."),
  });
  const traversalBody = await traversal.text();
  expect({
    status: traversal.status,
    authGuard: traversal.headers.get("x-auth-guard"),
    exposedGuardedContent: traversalBody.includes(GUARDED_MARKER),
  }).toEqual({
    status: 400,
    authGuard: null,
    exposedGuardedContent: false,
  });
}

describe.each([
  ["development", startDevServer],
  ["production", startProductionServer],
] as const)("interception source authorization (%s)", (_mode, startServer) => {
  let fixtureRoot = "";
  let server: StartedServer | undefined;

  beforeAll(async () => {
    fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, "vinext-interception-authz-");
    server = await startServer(fixtureRoot);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  // Interception routes paired with middleware mirror the Next.js topology in:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-segment-middleware/interception-dynamic-segment-middleware.test.ts
  // The forged source-context request is vinext-specific. The fixture mirrors
  // the reported application and request boundary:
  // /photos/[id] is intercepted from /feed/@modal/(...)photos/[id], while
  // middleware guards /feed/:path* and /feed/[...rest] exposes a marker.
  it("does not authorize and render different interception source paths", async () => {
    if (!server) throw new Error("Interception authorization fixture server did not start");
    await expectInterceptionSourceAuthorization(server.baseUrl);
  }, 30_000);
});
