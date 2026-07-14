import type { AddressInfo } from "node:net";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-action-process");
const NO_ACTIONS_FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-no-actions-process");
const INLINE_ACTION_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "fixtures/app-inline-action-process",
);
const CLIENT_BOUNDARY_ACTION_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "fixtures/app-client-boundary-action-process",
);
const PACKAGE_ACTION_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "fixtures/app-package-action-process",
);

async function retryUntil<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  let value = await operation();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await operation();
  }
  return value;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("App Router dev progressive action errors", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createServer({
      root: FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    expect((await fetch(baseUrl)).status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  // Ported from Next.js: test/e2e/app-dir/actions-unrecognized/actions-unrecognized.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-unrecognized/actions-unrecognized.test.ts
  it("renders an HTML 500 for an invalid progressive action reference", async () => {
    const body = new FormData();
    body.set("$ACTION_ID_not-a-server-reference", "");
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(response.headers.get("cache-tag")).toBeNull();
    expect(response.headers.get("x-action-config-headers")).toBe("present");
  });

  it("preserves the development cache policy when an actions-enabled page has no marker", async () => {
    const body = new FormData();
    body.set("ordinary-field", "value");
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(response.headers.get("cache-tag")).toBeNull();
    expect(response.headers.get("x-action-config-headers")).toBe("present");
  });
});

describe("App Router dev build without server actions", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createServer({
      root: NO_ACTIONS_FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: NO_ACTIONS_FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("returns action-not-found with the development cache policy", async () => {
    const body = new FormData();
    body.set("ordinary-field", "value");
    const response = await fetch(baseUrl, { method: "POST", body });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(await response.text()).toBe("Server action not found.");
  });
});

describe("App Router dev build with an inline server action", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createServer({
      root: INLINE_ACTION_FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: INLINE_ACTION_FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("classifies markerless posts globally without compiling an unrelated inline action route", async () => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: new FormData(),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});

describe("App Router dev action imported only by a client boundary", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createServer({
      root: CLIENT_BOUNDARY_ACTION_FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: CLIENT_BOUNDARY_ACTION_FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  it("discovers cold cross-route progressive and delayed actions without compiling a broken route", async () => {
    // Capture the browser-visible action reference from one dev process, then
    // restart. The next process must handle the action on a different route
    // without warming the owning /client-boundary route first.
    const html = await (await fetch(`${baseUrl}/client-boundary`)).text();
    const marker = html.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    expect(marker).toBeDefined();
    const actionId = marker!.slice("$ACTION_ID_".length);

    await server.close();
    server = await createServer({
      root: CLIENT_BOUNDARY_ACTION_FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: CLIENT_BOUNDARY_ACTION_FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    let address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const validBody = new FormData();
    validBody.set(marker!, "");
    const validResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: validBody,
    });
    expect(validResponse.status).toBe(200);
    expect(await validResponse.text()).toContain("Client-boundary action fixture");

    // Match Next.js' delayed-action navigation case: the client retains an
    // action reference, moves to another route, and dispatches it later as a
    // fetch action. Restart again so this path is independently cold.
    await server.close();
    server = await createServer({
      root: CLIENT_BOUNDARY_ACTION_FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: CLIENT_BOUNDARY_ACTION_FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    await new Promise((resolve) => setTimeout(resolve, 50));
    const delayedResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "next-action": actionId,
        origin: baseUrl,
      },
      body: "[]",
    });
    expect(delayedResponse.status).toBe(200);
    expect(delayedResponse.headers.get("content-type")).toContain("text/x-component");
    expect(await delayedResponse.text()).toContain("client-boundary-action");

    const invalidBody = new FormData();
    invalidBody.set("$ACTION_ID_not-a-server-reference", "");
    const invalidResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: invalidBody,
    });

    expect(invalidResponse.status).toBe(500);
    expect(invalidResponse.headers.get("content-type")).toContain("text/html");

    const routeBody = new FormData();
    routeBody.set("ordinary-field", "route-handler-value");
    const routeResponse = await fetch(`${baseUrl}/raw-action-request`, {
      method: "POST",
      body: routeBody,
    });

    expect(routeResponse.status).toBe(200);
    await expect(routeResponse.json()).resolves.toEqual({ field: "route-handler-value" });

    // The unrelated route is genuinely broken; its error remains local to a
    // request for that route instead of poisoning cold action discovery.
    expect((await fetch(`${baseUrl}/broken`)).status).toBe(500);
  });
});

describe("App Router dev action imported from a package", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  async function startServer(): Promise<void> {
    server = await createServer({
      root: PACKAGE_ACTION_FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: PACKAGE_ACTION_FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  beforeAll(startServer, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  // Ported from Next.js: test/e2e/app-dir/app-external/app-external.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-external/app-external.test.ts
  it("discovers a cold package-owned action through a package re-export", async () => {
    const html = await (await fetch(`${baseUrl}/package-action`)).text();
    const marker = html.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    expect(marker).toBeDefined();
    const actionId = marker!.slice("$ACTION_ID_".length);

    const ownerBody = new FormData();
    ownerBody.set(marker!, "");
    const ownerResponse = await fetch(`${baseUrl}/package-action`, {
      method: "POST",
      headers: { origin: baseUrl },
      body: ownerBody,
    });
    expect(ownerResponse.status).toBe(200);
    expect(await ownerResponse.text()).toContain("Package action fixture");

    await server.close();
    await startServer();

    const crossRouteBody = new FormData();
    crossRouteBody.set(marker!, "");
    const crossRouteResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: crossRouteBody,
    });
    expect(crossRouteResponse.status).toBe(200);
    expect(await crossRouteResponse.text()).toContain("Package action fixture home");

    await server.close();
    await startServer();

    const delayedResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "next-action": actionId,
        origin: baseUrl,
      },
      body: "[]",
    });
    expect(delayedResponse.status).toBe(200);
    expect(delayedResponse.headers.get("content-type")).toContain("text/x-component");
    expect(await delayedResponse.text()).toContain("package-action");

    const unreachableActionId = actionId.replace(
      "action.js#packageAction",
      "unreachable.js#unreachablePackageAction",
    );
    expect(unreachableActionId).not.toBe(actionId);
    const unreachableBody = new FormData();
    unreachableBody.set(`$ACTION_ID_${unreachableActionId}`, "");
    const unreachableResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: unreachableBody,
    });
    expect(unreachableResponse.status).toBe(500);
    expect(unreachableResponse.headers.get("content-type")).toContain("text/html");

    const typeOnlyActionId = actionId.replace(
      "action.js#packageAction",
      "type-only.ts#typeOnlyPackageAction",
    );
    expect(typeOnlyActionId).not.toBe(actionId);
    const typeOnlyBody = new FormData();
    typeOnlyBody.set(`$ACTION_ID_${typeOnlyActionId}`, "");
    const typeOnlyResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: typeOnlyBody,
    });
    expect(typeOnlyResponse.status).toBe(500);
    expect(typeOnlyResponse.headers.get("content-type")).toContain("text/html");

    const typeOnlyFetchResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "next-action": typeOnlyActionId,
        origin: baseUrl,
      },
      body: "[]",
    });
    expect(typeOnlyFetchResponse.status).toBe(404);
    expect(typeOnlyFetchResponse.headers.get("x-nextjs-action-not-found")).toBe("1");

    const forgedActionId = actionId.replace(
      "/node_modules/dev-package-action/action.js",
      "/node_modules/dev-forged-package/action.js",
    );
    expect(forgedActionId).not.toBe(actionId);
    const forgedResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "next-action": forgedActionId,
        origin: baseUrl,
      },
      body: "[]",
    });
    expect(forgedResponse.status).toBe(404);
    expect(forgedResponse.headers.get("x-nextjs-action-not-found")).toBe("1");

    expect((await fetch(`${baseUrl}/broken-package`)).status).toBe(500);
    expect((await fetch(baseUrl)).status).toBe(200);
  });
});

describe("App Router dev package-action reachability", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let tempDir: string;
  let fixtureDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(import.meta.dirname, ".tmp-dev-package-action-hmr-"));
    fixtureDir = path.join(tempDir, "fixture");
    await cp(PACKAGE_ACTION_FIXTURE_DIR, fixtureDir, { recursive: true });
    server = await createServer({
      root: fixtureDir,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: fixtureDir })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects type-only and stale package actions across HMR", async () => {
    const initialHtml = await (await fetch(`${baseUrl}/package-action`)).text();
    const marker = initialHtml.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    expect(marker).toBeDefined();
    const actionId = marker!.slice("$ACTION_ID_".length);
    const typeOnlyActionId = actionId.replace(
      "action.js#packageAction",
      "type-only.ts#typeOnlyPackageAction",
    );
    expect(typeOnlyActionId).not.toBe(actionId);

    const initialTypeOnlyBody = new FormData();
    initialTypeOnlyBody.set(`$ACTION_ID_${typeOnlyActionId}`, "");
    const initialTypeOnlyProgressive = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: initialTypeOnlyBody,
    });
    expect(initialTypeOnlyProgressive.status).toBe(500);
    expect(initialTypeOnlyProgressive.headers.get("content-type")).toContain("text/html");

    const initialTypeOnlyFetch = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "next-action": typeOnlyActionId,
        origin: baseUrl,
      },
      body: "[]",
    });
    expect(initialTypeOnlyFetch.status).toBe(404);
    expect(initialTypeOnlyFetch.headers.get("x-nextjs-action-not-found")).toBe("1");

    await writeFile(
      path.join(fixtureDir, "app/package-type-only/page.tsx"),
      `import { PackageActionLabel } from "dev-package-action/type-only";\nimport { packageTypeOnlyLabel } from "dev-package-action/type-only-reexport";\nconst label: PackageActionLabel = packageTypeOnlyLabel;\nexport default function PackageTypeOnlyPage() { return <p>{label} after HMR</p>; }\n`,
    );
    const hotTypeOnlyHtml = await retryUntil(
      async () => (await fetch(`${baseUrl}/package-type-only`)).text(),
      (html) => html.includes("after HMR"),
    );
    expect(hotTypeOnlyHtml).toContain("after HMR");

    const hotTypeOnlyBody = new FormData();
    hotTypeOnlyBody.set(`$ACTION_ID_${typeOnlyActionId}`, "");
    const hotTypeOnlyProgressive = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: hotTypeOnlyBody,
    });
    expect(hotTypeOnlyProgressive.status).toBe(500);
    expect(hotTypeOnlyProgressive.headers.get("content-type")).toContain("text/html");

    const hotTypeOnlyFetch = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "next-action": typeOnlyActionId,
        origin: baseUrl,
      },
      body: "[]",
    });
    expect(hotTypeOnlyFetch.status).toBe(404);
    expect(hotTypeOnlyFetch.headers.get("x-nextjs-action-not-found")).toBe("1");

    const liveBody = new FormData();
    liveBody.set(marker!, "");
    const liveProgressive = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: liveBody,
    });
    expect(liveProgressive.status).toBe(200);

    const liveFetch = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "next-action": actionId,
        origin: baseUrl,
      },
      body: "[]",
    });
    expect(liveFetch.status).toBe(200);
    expect(liveFetch.headers.get("content-type")).toContain("text/x-component");

    await writeFile(
      path.join(fixtureDir, "app/package-action/client-form.tsx"),
      `"use client";\nexport function PackageActionForm() { return <p>Package action removed</p>; }\n`,
    );
    const removedHtml = await retryUntil(
      async () => (await fetch(`${baseUrl}/package-action`)).text(),
      (html) => html.includes("Package action removed") && !html.includes("$ACTION_ID_"),
    );
    expect(removedHtml).not.toContain("$ACTION_ID_");

    const staleBody = new FormData();
    staleBody.set(marker!, "");
    const staleResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: staleBody,
    });
    expect(staleResponse.status).toBe(404);
    expect(staleResponse.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await staleResponse.text()).toBe("Server action not found.");
    expect((await fetch(baseUrl)).status).toBe(200);
  });
});

describe("App Router dev server-action HMR", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let tempDir: string;
  let fixtureDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(import.meta.dirname, ".tmp-dev-action-hmr-"));
    fixtureDir = path.join(tempDir, "fixture");
    await cp(NO_ACTIONS_FIXTURE_DIR, fixtureDir, { recursive: true });
    server = await createServer({
      root: fixtureDir,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: fixtureDir })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("tracks hot-added and hot-removed server actions", async () => {
    const markerlessPost = async () => {
      const body = new FormData();
      body.set("ordinary-field", "value");
      return fetch(baseUrl, { method: "POST", headers: { origin: baseUrl }, body });
    };

    // Prime both the RSC entry and the action-capability validation module while
    // the live plugin-rsc manifest is empty.
    const initial = await markerlessPost();
    expect(initial.status).toBe(404);
    expect(initial.headers.get("x-nextjs-action-not-found")).toBe("1");

    await writeFile(
      path.join(fixtureDir, "app/actions.ts"),
      `"use server";\nexport type HotActionResult = string;\nexport async function hotAction() { return "hot-action-ok"; }\n`,
    );
    await writeFile(
      path.join(fixtureDir, "app/client-shell.tsx"),
      `"use client";\nimport { hotAction } from "./actions";\nexport function ClientShell() { return <form action={hotAction}><button type="submit">Run hot action</button></form>; }\n`,
    );

    const addedHtml = await retryUntil(
      async () => (await fetch(baseUrl)).text(),
      (html) => html.includes("Run hot action") && html.includes("$ACTION_ID_"),
    );
    const marker = addedHtml.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    expect(marker).toBeDefined();

    const actionBody = new FormData();
    actionBody.set(marker!, "");
    const actionResponse = await retryUntil(
      () =>
        fetch(baseUrl, {
          method: "POST",
          headers: { origin: baseUrl },
          body: actionBody,
        }),
      (response) => response.status === 200,
    );
    expect(actionResponse.status).toBe(200);

    const enabledMarkerless = await markerlessPost();
    expect(enabledMarkerless.status).toBe(500);

    await writeFile(
      path.join(fixtureDir, "app/client-shell.tsx"),
      `"use client";\nimport { type HotActionResult } from "./actions";\nconst label: HotActionResult = "No server actions after HMR";\nexport function ClientShell() { return <p>{label}</p>; }\n`,
    );
    // Keep actions.ts and a type-only import on disk. Removing the final live
    // import must prune its reference from capability validation even though
    // plugin-RSC's metadata map is append-only across this HMR update.

    const removedHtml = await retryUntil(
      async () => (await fetch(baseUrl)).text(),
      (html) => html.includes("No server actions after HMR") && !html.includes("$ACTION_ID_"),
    );
    expect(removedHtml).not.toContain("$ACTION_ID_");

    const removedMarkerless = await retryUntil(
      markerlessPost,
      (response) =>
        response.status === 404 && response.headers.get("x-nextjs-action-not-found") === "1",
    );
    expect(removedMarkerless.status).toBe(404);
    expect(removedMarkerless.headers.get("x-nextjs-action-not-found")).toBe("1");

    const staleActionBody = new FormData();
    staleActionBody.set(marker!, "");
    const staleAction = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: staleActionBody,
    });
    expect(staleAction.status).toBe(404);
    expect(staleAction.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await staleAction.text()).toBe("Server action not found.");

    // Neither transition may poison the dev process for subsequent requests.
    expect((await fetch(baseUrl)).status).toBe(200);
  }, 30_000);
});

describe("App Router dev server-action discovery races", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let tempDir: string;
  let fixtureDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(import.meta.dirname, ".tmp-dev-action-race-"));
    fixtureDir = path.join(tempDir, "fixture");
    await cp(CLIENT_BOUNDARY_ACTION_FIXTURE_DIR, fixtureDir, { recursive: true });
  });

  afterAll(async () => {
    await server?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("does not publish an in-flight pre-HMR capability snapshot", async () => {
    const scanEntered = createDeferred();
    const releaseScan = createDeferred();
    const invalidationObserved = createDeferred();
    let delayNextActionScan = true;
    const racePlugin: Plugin = {
      name: "test:delay-dev-action-discovery",
      transform: {
        filter: { id: /app\/client-boundary\/actions\.ts$/ },
        async handler(code) {
          if (this.environment.name !== "ssr" || !delayNextActionScan) return null;
          delayNextActionScan = false;
          scanEntered.resolve();
          await releaseScan.promise;
          return { code, map: null };
        },
      },
      hotUpdate: {
        handler(ctx) {
          if (
            this.environment.name === "rsc" &&
            ctx.file.endsWith("/app/client-boundary/client-form.tsx")
          ) {
            invalidationObserved.resolve();
          }
        },
      },
    };

    server = await createServer({
      root: fixtureDir,
      configFile: false,
      logLevel: "silent",
      plugins: [racePlugin, vinext({ appDir: fixtureDir })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const body = new FormData();
    body.set("ordinary-field", "value");
    const pendingResponse = fetch(`${baseUrl}/client-boundary`, {
      method: "POST",
      headers: { origin: baseUrl },
      body,
    });

    await scanEntered.promise;
    await writeFile(
      path.join(fixtureDir, "app/client-boundary/client-form.tsx"),
      `"use client";\nexport function ClientForm() { return <p>No action after race</p>; }\n`,
    );
    await invalidationObserved.promise;
    releaseScan.resolve();

    const response = await pendingResponse;
    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response.text()).toBe("Server action not found.");

    const stableResponse = await fetch(`${baseUrl}/client-boundary`, {
      method: "POST",
      headers: { origin: baseUrl },
      body: new FormData(),
    });
    expect(stableResponse.status).toBe(404);
    expect(stableResponse.headers.get("x-nextjs-action-not-found")).toBe("1");
  }, 30_000);
});
