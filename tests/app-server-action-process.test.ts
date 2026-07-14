import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { build, createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-action-process");
const PROD_SERVER_SOURCE = path.resolve(
  import.meta.dirname,
  "../packages/vinext/src/server/prod-server.ts",
);
const SERVER_HELPER = path.join(FIXTURE_DIR, "start-server.mjs");

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function expectServerActionNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe(
    "no-cache, no-store, max-age=0, must-revalidate",
  );
  expect(response.headers.get("cdn-cache-control")).toBeNull();
  expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
  expect(response.headers.get("cache-tag")).toBeNull();
  expect(response.headers.get("x-vinext-server-action-response")).toBeNull();
}

function getFormActionId(html: string, formId: string): string {
  const form = html.match(new RegExp(`<form[^>]*id="${formId}"[^>]*>[\\s\\S]*?</form>`))?.[0];
  const actionId = form?.match(/name="\$ACTION_ID_([^"]+)"/)?.[1];
  if (!actionId) throw new Error(`Missing action id for form ${formId}`);
  return actionId;
}

async function waitForServerPort(child: ChildProcess, getOutput: () => string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = getOutput().match(/VINEXT_TEST_PORT=(\d+)/);
    if (match) return Number(match[1]);
    if (child.exitCode !== null) {
      throw new Error(`Production server exited before startup:\n${getOutput()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for production server:\n${getOutput()}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

describe("App Router production server action process isolation", () => {
  let child: ChildProcess | undefined;
  let output = "";
  let tempDir: string;
  let baseUrl: string;
  let validActionIds: string[];
  let unselectedActionId: string;
  let boundActionMarker: string;
  let boundActionFields: [string, string][];
  let stateActionMarker: string;
  let stateActionFields: [string, string][];
  let stateActionKey: string;
  let unboundStateActionId: string;
  let successfulFetchActionId: string;
  let failedFetchActionId: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(import.meta.dirname, ".tmp-action-process-"));
    const outDir = path.join(FIXTURE_DIR, "dist");
    const builder = await createBuilder({
      root: FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: FIXTURE_DIR })],
    });
    await builder.buildApp();

    const runtimeDir = path.join(tempDir, "runtime");
    await build({
      root: path.resolve(import.meta.dirname, ".."),
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: runtimeDir,
        ssr: PROD_SERVER_SOURCE,
        rolldownOptions: { output: { entryFileNames: "prod-server.mjs" } },
      },
    });

    child = spawn(
      process.execPath,
      [SERVER_HELPER, path.join(runtimeDir, "prod-server.mjs"), outDir],
      { cwd: path.resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    const port = await waitForServerPort(child, () => output);
    baseUrl = `http://127.0.0.1:${port}`;

    const initial = await fetch(baseUrl);
    expect(initial.status).toBe(200);
    const html = await initial.text();
    validActionIds = [...html.matchAll(/name="\$ACTION_ID_([^"]+)"/g)].map((match) => match[1]);
    expect(validActionIds).toHaveLength(2);
    const boundMarkerMatch = html.match(/name="(\$ACTION_REF_([^"]+))"/);
    expect(boundMarkerMatch).toBeTruthy();
    boundActionMarker = boundMarkerMatch![1];
    const boundFieldPrefix = `$ACTION_${boundMarkerMatch![2]}:`;
    boundActionFields = [...html.matchAll(/name="(\$ACTION_[^"]+)" value="([^"]*)"/g)]
      .filter((match) => match[1].startsWith(boundFieldPrefix))
      .map((match) => [match[1], decodeHtmlAttribute(match[2])]);
    expect(boundActionFields).toHaveLength(2);

    const stateHtml = await (await fetch(`${baseUrl}/state`)).text();
    const stateMarkerMatch = stateHtml.match(/name="(\$ACTION_REF_([^"]+))"/);
    expect(stateMarkerMatch).toBeTruthy();
    stateActionMarker = stateMarkerMatch![1];
    const stateFieldPrefix = `$ACTION_${stateMarkerMatch![2]}:`;
    stateActionFields = [...stateHtml.matchAll(/name="(\$ACTION_[^"]+)" value="([^"]*)"/g)]
      .filter((match) => match[1].startsWith(stateFieldPrefix))
      .map((match) => [match[1], decodeHtmlAttribute(match[2])]);
    expect(stateActionFields.length).toBeGreaterThan(0);
    const stateKeyMatch = stateHtml.match(/name="\$ACTION_KEY" value="([^"]*)"/);
    expect(stateKeyMatch).toBeTruthy();
    stateActionKey = decodeHtmlAttribute(stateKeyMatch![1]);

    const unboundStateMatch = stateHtml.match(/name="\$ACTION_ID_([^"]+)"/);
    expect(unboundStateMatch).toBeTruthy();
    unboundStateActionId = unboundStateMatch![1];

    const fetchActionsHtml = await (await fetch(`${baseUrl}/fetch-actions`)).text();
    successfulFetchActionId = getFormActionId(fetchActionsHtml, "successful-fetch-action");
    failedFetchActionId = getFormActionId(fetchActionsHtml, "failed-fetch-action");

    // Capture the lazily routed action id, then restart the production process
    // so its module is definitely unevaluated for the preflight test below.
    const unselectedHtml = await (await fetch(`${baseUrl}/unselected`)).text();
    const unselectedMatch = unselectedHtml.match(/name="\$ACTION_ID_([^"]+)"/);
    expect(unselectedMatch).toBeTruthy();
    unselectedActionId = unselectedMatch![1];

    child.kill("SIGTERM");
    expect(await waitForExit(child, 3_000)).toBe(true);
    output = "";
    child = spawn(
      process.execPath,
      [SERVER_HELPER, path.join(runtimeDir, "prod-server.mjs"), outDir],
      { cwd: path.resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    const restartedPort = await waitForServerPort(child, () => output);
    baseUrl = `http://127.0.0.1:${restartedPort}`;
  }, 60_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 3_000);
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    await rm(path.join(FIXTURE_DIR, "dist"), { recursive: true, force: true });
    await rm(path.join(FIXTURE_DIR, ".next"), { recursive: true, force: true });
    await rm(path.join(FIXTURE_DIR, "next-env.d.ts"), { force: true });
  });

  // Ported from Next.js: test/e2e/app-dir/actions-unrecognized/actions-unrecognized.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-unrecognized/actions-unrecognized.test.ts
  // Next.js validates every progressive action reference before decoding:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/action-handler.ts
  it.each([
    {
      name: "unknown",
      createBody: () => {
        const body = new FormData();
        body.set("$ACTION_ID_a#b", "");
        body.set("$ACTION_ID_c#d", "");
        return body;
      },
    },
    {
      name: "malformed bound",
      createBody: () => {
        const body = new FormData();
        body.set(`$ACTION_ID_${validActionIds[0]}`, "");
        body.set("$ACTION_REF_broken", "");
        body.set("$ACTION_broken:0", "not-json");
        return body;
      },
    },
    {
      name: "missing export",
      createBody: () => {
        const body = new FormData();
        const actionId = validActionIds[0];
        body.set(`$ACTION_ID_${actionId.slice(0, actionId.lastIndexOf("#"))}#missing`, "");
        return body;
      },
    },
  ])("returns Next.js' production 500 for $name page action references", async ({ createBody }) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      body: createBody(),
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("x-nextjs-action-not-found")).toBeNull();
    expectServerActionNoStore(response);
    expect(await response.text()).toBe("Internal Server Error");

    expect(await waitForExit(child!, 500)).toBe(false);
    const afterFailure = await fetch(baseUrl);
    expect(afterFailure.status).toBe(200);
  });

  it("passes action-shaped multipart fields through to App Route Handlers", async () => {
    const body = new FormData();
    body.set("$ACTION_ID_first", "first-value");
    body.set("$ACTION_ID_second", "second-value");

    const response = await fetch(`${baseUrl}/action-fields`, {
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      ["$ACTION_ID_first", "first-value"],
      ["$ACTION_ID_second", "second-value"],
    ]);
    expect(child!.exitCode).toBeNull();
  });

  it("applies the fixture's cacheable middleware and config headers to ordinary responses", async () => {
    const response = await fetch(`${baseUrl}/success`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("cdn-cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("cache-tag")).toBe("action-process-fixture");
    expect(response.headers.get("x-action-config-headers")).toBe("present");
  });

  it.each(["next-action", "x-rsc-action"])(
    "passes a raw POST carrying %s through to App Route Handlers",
    async (actionHeader) => {
      const response = await fetch(`${baseUrl}/raw-action-request`, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          [actionHeader]: "not-a-page-action",
        },
        body: "raw-route-body",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        body: "raw-route-body",
        contentType: "text/plain; charset=utf-8",
        nextAction: actionHeader === "next-action" ? "not-a-page-action" : null,
        rscAction: actionHeader === "x-rsc-action" ? "not-a-page-action" : null,
      });
      expect(child!.exitCode).toBeNull();
    },
  );

  it("returns Next.js' production 500 for an actions-enabled page without a marker", async () => {
    const body = new FormData();
    body.set("ordinary-field", "value");

    const response = await fetch(baseUrl, {
      method: "POST",
      body,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("x-nextjs-action-not-found")).toBeNull();
    expectServerActionNoStore(response);
    expect(await response.text()).toBe("Internal Server Error");
    expect(child!.exitCode).toBeNull();
  });

  it("rejects an invalid reference before evaluating an earlier valid action module", async () => {
    expect(await (await fetch(`${baseUrl}/module-loads`)).json()).toEqual({ unselected: 0 });

    const body = new FormData();
    body.set(`$ACTION_ID_${unselectedActionId}`, "");
    body.set("$ACTION_ID_invalid#action", "");
    const response = await fetch(baseUrl, {
      method: "POST",
      body,
      redirect: "manual",
    });

    expect(response.status).toBe(500);
    expectServerActionNoStore(response);
    expect(await (await fetch(`${baseUrl}/module-loads`)).json()).toEqual({ unselected: 0 });
    expect(await waitForExit(child!, 500)).toBe(false);
  });

  it("passes the original valid marker sequence to React's decoder", async () => {
    expect(await (await fetch(`${baseUrl}/module-loads`)).json()).toEqual({ unselected: 0 });

    const body = new FormData();
    body.set(`$ACTION_ID_${unselectedActionId}`, "");
    body.set(`$ACTION_ID_${validActionIds[0]}`, "");
    const response = await fetch(baseUrl, {
      method: "POST",
      body,
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${baseUrl}/success`);
    expectServerActionNoStore(response);
    expect(await (await fetch(`${baseUrl}/module-loads`)).json()).toEqual({ unselected: 1 });
    expect(child!.exitCode).toBeNull();
  });

  it("still executes a valid progressive action after a malformed request", async () => {
    const valid = new FormData();
    valid.set(`$ACTION_ID_${validActionIds[0]}`, "");
    const response = await fetch(baseUrl, {
      method: "POST",
      body: valid,
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${baseUrl}/success`);
    expectServerActionNoStore(response);
    expect(child!.exitCode).toBeNull();
  });

  it("preserves the decoder's last-marker behavior for valid action references", async () => {
    const valid = new FormData();
    valid.set(`$ACTION_ID_${validActionIds[0]}`, "");
    valid.set(`$ACTION_ID_${validActionIds[1]}`, "");
    const response = await fetch(baseUrl, {
      method: "POST",
      body: valid,
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${baseUrl}/other-success`);
    expectServerActionNoStore(response);
    expect(child!.exitCode).toBeNull();
  });

  it("preflights bound and unbound references without changing the selected action", async () => {
    const valid = new FormData();
    valid.set(`$ACTION_ID_${validActionIds[0]}`, "");
    valid.set(boundActionMarker, "");
    for (const [key, value] of boundActionFields) valid.set(key, value);
    const response = await fetch(baseUrl, {
      method: "POST",
      body: valid,
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${baseUrl}/bound-success`);
    expectServerActionNoStore(response);
    expect(child!.exitCode).toBeNull();
  });

  it("rejects reordered bound descriptors before decoding and keeps serving requests", async () => {
    const descriptorEntry = boundActionFields.find(([key]) => key.endsWith(":0"));
    expect(descriptorEntry).toBeTruthy();
    const descriptor = JSON.parse(descriptorEntry![1]) as Record<string, unknown>;
    const reorderedDescriptor = JSON.stringify({
      ...Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== "id")),
      id: descriptor.id,
    });
    expect(reorderedDescriptor.startsWith('{"id":"')).toBe(false);

    const body = new FormData();
    body.set(boundActionMarker, "");
    for (const [key, value] of boundActionFields) {
      body.set(key, key === descriptorEntry![0] ? reorderedDescriptor : value);
    }

    const response = await fetch(baseUrl, {
      method: "POST",
      body,
      redirect: "manual",
    });

    expect(response.status).toBe(500);
    expectServerActionNoStore(response);
    expect(await response.text()).toBe("Internal Server Error");
    expect(await waitForExit(child!, 500)).toBe(false);

    const afterFailure = await fetch(baseUrl);
    expect(afterFailure.status).toBe(200);
  });

  it("preserves useActionState metadata when a later unbound marker wins", async () => {
    // Next.js passes the original body to decodeFormState after React's
    // last-marker-wins decodeAction selection:
    // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/app-render/action-handler.ts
    const body = new FormData();
    body.set(stateActionMarker, "");
    for (const [key, value] of stateActionFields) body.set(key, value);
    body.set("$ACTION_KEY", stateActionKey);
    body.set("value", "mixed");
    body.set(`$ACTION_ID_${unboundStateActionId}`, "");

    const response = await fetch(`${baseUrl}/state`, {
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expectServerActionNoStore(response);
    expect(response.headers.get("x-action-config-headers")).toBe("present");
    expect(await response.text()).toContain('id="state-value">unbound:mixed</p>');
    expect(child!.exitCode).toBeNull();
  });

  it.each([
    { name: "successful", getActionId: () => successfulFetchActionId, status: 200 },
    { name: "failed", getActionId: () => failedFetchActionId, status: 500 },
  ])(
    "reasserts action cache isolation after middleware and config headers for $name fetch actions",
    async ({ getActionId, status }) => {
      const response = await fetch(`${baseUrl}/fetch-actions`, {
        method: "POST",
        headers: {
          accept: "text/x-component",
          "content-type": "text/plain;charset=UTF-8",
          "next-action": getActionId(),
          origin: baseUrl,
          rsc: "1",
        },
        body: "[]",
      });

      expect(response.status).toBe(status);
      expectServerActionNoStore(response);
      expect(response.headers.get("x-action-config-headers")).toBe("present");
      expect(child!.exitCode).toBeNull();
    },
  );
});
