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

function forgedActionRequest(
  baseUrl: string,
  actionId: string,
  source: string,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "Next-Action": actionId,
      Origin: baseUrl,
      "X-Vinext-Interception-Context": source,
      ...extraHeaders,
    },
    body: "[]",
  };
}

async function readPhotoActionId(baseUrl: string): Promise<string> {
  const html = await (await fetch(`${baseUrl}/photos/1`)).text();
  const actionId = html.match(/name="\$ACTION_ID_([^"]+)"/)?.[1];
  if (!actionId) throw new Error("Photo page did not render its server action form");
  return actionId;
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

  // Static segments match the raw path, as in Next.js, so a direct request to
  // `/%66eed/secret` reaches no `/feed` route, and neither does the claimed
  // source: the target renders without interception.
  const encodedAlias = await fetch(`${baseUrl}/photos/1`, {
    headers: interceptionHeaders("/%66eed/secret"),
  });
  const encodedAliasBody = await encodedAlias.text();
  expect({
    status: encodedAlias.status,
    exposedGuardedContent: encodedAliasBody.includes(GUARDED_MARKER),
  }).toEqual({
    status: 200,
    exposedGuardedContent: false,
  });

  // A server action rerenders the page it was posted to, intercepted tree
  // included, so a forged source context reaches the same render. The vinext
  // client always sends `RSC: 1` with action POSTs; that request must still
  // authorize the source, and one without it must not render the source at all.
  const actionId = await readPhotoActionId(baseUrl);
  const rscAction = await fetch(
    `${baseUrl}/photos/1`,
    forgedActionRequest(baseUrl, actionId, "/feed/secret", interceptionHeaders("/feed/secret")),
  );
  expect(rscAction.status).toBe(403);
  expect(rscAction.headers.get("x-auth-guard")).toBe("blocked");
  expect(await rscAction.text()).not.toContain(GUARDED_MARKER);

  const nonRscAction = await fetch(
    `${baseUrl}/photos/1`,
    forgedActionRequest(baseUrl, actionId, "/feed/secret"),
  );
  const nonRscActionBody = await nonRscAction.text();
  expect({
    status: nonRscAction.status,
    authGuard: nonRscAction.headers.get("x-auth-guard"),
    rendersTarget: nonRscActionBody.includes("Refresh"),
    exposedGuardedContent: nonRscActionBody.includes(GUARDED_MARKER),
  }).toEqual({
    status: 200,
    authGuard: null,
    rendersTarget: true,
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
