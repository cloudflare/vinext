import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createBuilder } from "vite";
import { waitForAppRouterHydration, waitForHydration } from "../helpers";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";

// Two real production builds of one fixture stand in for a deploy. The second
// build comes from changed source files, so its chunk names and its RSC
// compatibility id both differ from the first. A gateway on one port forwards
// to whichever build is "live", and a test swaps the live build while a browser
// tab stays open. The gateway can also cut a response short, which gives a real
// network failure instead of one injected through the browser's inspector.
//
// Ported from Next.js: test/production/chunk-load-failure/chunk-load-failure.test.ts
// https://github.com/vercel/next.js/blob/canary/test/production/chunk-load-failure/chunk-load-failure.test.ts

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/stale-build-recovery");
const LOAD_COUNT_KEY = "__STALE_BUILD_E2E_LOADS__";
const ERROR_UI_KEY = "__STALE_BUILD_E2E_ERROR_UI__";
const COMPATIBILITY_HEADER = "x-vinext-rsc-compatibility-id";
const CHUNKS_URL_PREFIX = "/_next/static/chunks/";

type SiteLabel = "A" | "B" | "hybrid";
type Site = {
  entryPath: string;
  label: SiteLabel;
  pagesEntryPath: string | null;
  root: string;
  version: "A" | "B";
};

const sites = {} as Record<SiteLabel, Site>;
let origin = "";
let gateway: http.Server | null = null;
let upstreamPort = 0;
const pendingCutoffs = new Map<string, number>();
const pendingDelays = new Map<string, number>();
let running: { label: SiteLabel; server: ChildProductionServer } | null = null;
let scratchRoot = "";
// Loaded through a dynamic import, like the plugin, so both resolve one module
// instance under Playwright's loader.
let recovery: typeof import("../../../packages/vinext/src/client/chunk-load-recovery.js");

test.describe.configure({ retries: 0 });
test.setTimeout(90_000);
// Playwright disables Chromium's back/forward cache by default; real tabs have it.
test.use({ launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] } });

function forwardToLiveBuild(request: http.IncomingMessage, response: http.ServerResponse): void {
  const forwarded = http.request(
    {
      agent: false,
      headers: request.headers,
      hostname: "127.0.0.1",
      method: request.method,
      path: request.url,
      port: upstreamPort,
    },
    (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    },
  );
  forwarded.on("error", () => response.destroy());
  response.on("close", () => forwarded.destroy());
  request.pipe(forwarded);
}

async function startGateway(): Promise<void> {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://gateway.invalid");

    const remaining = pendingCutoffs.get(pathname) ?? 0;
    if (remaining > 0) {
      pendingCutoffs.set(pathname, remaining - 1);
      // A reset before any byte is retried by the browser on a fresh connection.
      // Promising a long body and dropping the connection is a failure it reports.
      response.writeHead(200, { "content-length": "1000000", "content-type": "text/javascript" });
      response.flushHeaders();
      setTimeout(() => request.socket.destroy(), 25);
      return;
    }

    const delay = pendingDelays.get(pathname);
    if (delay !== undefined) {
      pendingDelays.delete(pathname);
      setTimeout(() => forwardToLiveBuild(request, response), delay);
      return;
    }

    forwardToLiveBuild(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  gateway = server;
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Holds the next request for `pathname` for `milliseconds` before forwarding it, so its navigation stays pending. */
function delayNextRequest(pathname: string, milliseconds: number): void {
  pendingDelays.set(pathname, milliseconds);
}

/** Cuts the response to the next `count` requests for `pathname` short, as a dropped connection does. */
function cutNextResponses(pathname: string, count = 1): void {
  pendingCutoffs.set(pathname, count);
}

async function buildSite(
  label: SiteLabel,
  options: { hybrid?: boolean; version: "A" | "B" },
): Promise<Site> {
  const root = path.join(scratchRoot, label);
  await fs.cp(FIXTURE_DIR, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== "hybrid-overlay",
  });
  if (options.version === "B") {
    // Every client chunk that shows the version changes, and so does the entry
    // chunk that names them. The bare module has no imports, so it needs its own edit.
    await fs.writeFile(path.join(root, "app/version.ts"), 'export const VERSION = "B";\n');
    const barePath = path.join(root, "app/react-lazy/bare-thing.tsx");
    const bare = await fs.readFile(barePath, "utf8");
    await fs.writeFile(barePath, bare.replace("BARE_THING_MARKER", "BARE_THING_MARKER_B"));
  }
  if (options.hybrid) {
    await fs.cp(path.join(FIXTURE_DIR, "hybrid-overlay"), root, { recursive: true });
  }
  await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");

  const vinext = (await import("../../../packages/vinext/src/index.js")).default;
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "dist/client/vinext-client-entry-manifest.json"), "utf8"),
  ) as { appBrowserEntry: string; pagesClientEntry?: string };
  return {
    entryPath: `/${manifest.appBrowserEntry}`,
    label,
    pagesEntryPath: manifest.pagesClientEntry ? `/${manifest.pagesClientEntry}` : null,
    root,
    version: options.version,
  };
}

async function expectServing(label: SiteLabel): Promise<void> {
  const { entryPath, version } = sites[label];
  await expect
    .poll(
      async () => {
        if (running?.server.failure) throw running.server.failure;
        try {
          const html = await (await fetch(`${origin}/`)).text();
          return html.includes(entryPath) && html.includes(`Version ${version}`);
        } catch {
          return false;
        }
      },
      { message: `the ${label} build should answer on ${origin}`, timeout: 20_000 },
    )
    .toBe(true);
}

/**
 * Makes the named build the live one behind the gateway, then health-checks it.
 * The new build starts before the old one stops, as a deploy replaces assets
 * without a gap.
 */
async function serve(label: SiteLabel): Promise<void> {
  if (running?.label !== label) {
    const previous = running;
    const server = await startChildProductionServer(sites[label].root);
    running = { label, server };
    upstreamPort = server.port;
    if (previous) await stopChildProductionServer(previous.server);
  }
  await expectServing(label);
}

/** Lines the fixture's Server Actions appended while the named build was live. */
async function readActionRuns(label: SiteLabel): Promise<string[]> {
  try {
    const log = await fs.readFile(path.join(sites[label].root, "action-runs.log"), "utf8");
    return log.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** The URL path of the one built chunk whose source contains `marker`, or whose file name starts with `namePrefix`. */
async function findChunkPath(
  label: SiteLabel,
  match: { marker: string } | { namePrefix: string },
): Promise<string> {
  const chunksDir = path.join(sites[label].root, "dist/client/_next/static/chunks");
  const matches: string[] = [];
  for (const name of await fs.readdir(chunksDir)) {
    if (!name.endsWith(".js")) continue;
    const found =
      "namePrefix" in match
        ? name.startsWith(match.namePrefix)
        : (await fs.readFile(path.join(chunksDir, name), "utf8")).includes(match.marker);
    if (found) matches.push(name);
  }
  expect(matches, `chunks matching ${JSON.stringify(match)} in the ${label} build`).toHaveLength(1);
  return `${CHUNKS_URL_PREFIX}${matches[0]}`;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  recovery = await import("../../../packages/vinext/src/client/chunk-load-recovery.js");
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-stale-build-e2e-"));
  await startGateway();
  sites.A = await buildSite("A", { version: "A" });
  sites.B = await buildSite("B", { version: "B" });
  sites.hybrid = await buildSite("hybrid", { hybrid: true, version: "A" });
  expect(sites.B.entryPath, "a deploy renames the entry chunk").not.toBe(sites.A.entryPath);
});

test.afterAll(async () => {
  if (running) await stopChildProductionServer(running.server);
  running = null;
  gateway?.closeAllConnections();
  gateway?.close();
  if (scratchRoot) await fs.rm(scratchRoot, { recursive: true, force: true });
});

test.beforeEach(async () => {
  pendingCutoffs.clear();
  pendingDelays.clear();
  for (const site of Object.values(sites)) {
    await fs.rm(path.join(site.root, "action-runs.log"), { force: true });
  }
});

type Tab = {
  consoleMessages: { text: string; type: string }[];
  documentLoads(): Promise<number>;
  entryUrl: string;
  errorUiDocuments(): Promise<number[]>;
  headProbes: string[];
  navigations: string[];
  page: Page;
  pageErrors: string[];
  requests: { method: string; status: number; url: string }[];
};

async function readSessionValue<T>(page: Page, key: string, fallback: T): Promise<T> {
  try {
    return await page.evaluate(
      ([storageKey, empty]) =>
        JSON.parse(window.sessionStorage.getItem(storageKey as string) ?? (empty as string)),
      [key, JSON.stringify(fallback)],
    );
  } catch {
    // The document is being replaced; a poll reads again.
    return fallback;
  }
}

/**
 * Opens a document and records what a chunk-load recovery is judged on:
 * document loads in this tab, HEAD probes, asset requests, document requests,
 * console output, and the documents in which the error boundary ever rendered.
 */
async function openTab(
  page: Page,
  pathname: string,
  options: { hydration?: "app" | "none" | "pages" } = {},
): Promise<Tab> {
  const { hydration = "app" } = options;
  await page.addInitScript(
    ({ errorKey, loadKey }) => {
      const loads = Number(window.sessionStorage.getItem(loadKey) ?? "0") + 1;
      window.sessionStorage.setItem(loadKey, String(loads));
      new MutationObserver(() => {
        if (!document.getElementById("error-boundary")) return;
        const seen: number[] = JSON.parse(window.sessionStorage.getItem(errorKey) ?? "[]");
        if (!seen.includes(loads))
          window.sessionStorage.setItem(errorKey, JSON.stringify([...seen, loads]));
      }).observe(document, { childList: true, subtree: true });
    },
    { errorKey: ERROR_UI_KEY, loadKey: LOAD_COUNT_KEY },
  );

  const tab: Tab = {
    consoleMessages: [],
    documentLoads: async () => (await readSessionValue(page, LOAD_COUNT_KEY, Number.NaN)) - 1,
    entryUrl: "",
    errorUiDocuments: () => readSessionValue<number[]>(page, ERROR_UI_KEY, []),
    headProbes: [],
    navigations: [],
    page,
    pageErrors: [],
    requests: [],
  };
  page.on("console", (message) => {
    tab.consoleMessages.push({ text: message.text(), type: message.type() });
  });
  page.on("pageerror", (error) => tab.pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "HEAD") tab.headProbes.push(request.url());
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      tab.navigations.push(new URL(request.url()).pathname);
    }
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/_next/static/")) {
      tab.requests.push({
        method: response.request().method(),
        status: response.status(),
        url: response.url(),
      });
    }
  });

  await page.goto(`${origin}${pathname}`);
  if (hydration === "app") await waitForAppRouterHydration(page);
  if (hydration === "pages") await waitForHydration(page);
  // Pages Router documents carry no App Router entry script.
  const entryScript = page.locator("script#_R_");
  if ((await entryScript.count()) > 0) {
    tab.entryUrl = new URL((await entryScript.getAttribute("src"))!, origin).href;
  }
  return tab;
}

/** Waits for the expected number of document loads, then confirms none follow. */
async function expectDocumentLoads(tab: Tab, expected: number): Promise<void> {
  await expect.poll(() => tab.documentLoads(), { timeout: 20_000 }).toBe(expected);
  await tab.page.waitForTimeout(1_500);
  expect(await tab.documentLoads()).toBe(expected);
}

/** Every HEAD request of a probing scenario must target the document's entry script. */
function expectProbesOnEntry(tab: Tab): void {
  expect(tab.headProbes.length, "the recovery should probe the build").toBeGreaterThan(0);
  expect(tab.entryUrl, "the document should carry the entry script").not.toBe("");
  expect([...new Set(tab.headProbes)]).toEqual([tab.entryUrl]);
}

type ChunkFaultMode = "404" | "abort" | "hold";

/**
 * Browser-level network faults for one page, for the scenarios that need a
 * chunk to fail on a build that is otherwise live. Chunk requests reach the
 * fault handler until the page starts a document navigation after
 * `skipNavigations` earlier ones (the recovery load): from then on the chunk
 * loads normally.
 */
function createFaults(
  page: Page,
  options: { healOnNavigation?: boolean; skipNavigations?: number } = {},
) {
  const { healOnNavigation = true, skipNavigations = 0 } = options;
  const chunkRequests: string[] = [];
  const releases: (() => void)[] = [];
  let healed = false;
  let navigations = 0;

  page.on("request", (request) => {
    if (!healOnNavigation) return;
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    navigations += 1;
    if (navigations > skipNavigations) healed = true;
  });

  return {
    chunkRequests,
    async breakChunk(chunkPath: string, mode: ChunkFaultMode): Promise<void> {
      await page.route(
        (url) => url.pathname === chunkPath,
        async (route) => {
          chunkRequests.push(route.request().method());
          if (healed) {
            await route.continue();
          } else if (mode === "404") {
            await route.fulfill({ body: "not found", contentType: "text/plain", status: 404 });
          } else if (mode === "hold") {
            await new Promise<void>((resolve) => releases.push(resolve));
            await route.abort().catch(() => {});
          } else {
            await route.abort("connectionreset");
          }
        },
      );
    },
    /** Makes the entry script answer HEAD with 404, the way a replaced build does, until `unroute`. */
    async breakEntryProbe(entryUrl: string): Promise<void> {
      await page.route(entryUrl, async (route) => {
        if (route.request().method() === "HEAD") {
          await route.fulfill({ body: "", status: 404 });
        } else {
          await route.continue();
        }
      });
    },
    async unroute(): Promise<void> {
      for (const release of releases.splice(0)) release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    },
  };
}

/**
 * Whether this engine fetches a failed module again: an import that fails once
 * and then succeeds tells the two apart.
 */
async function detectModuleRefetch(
  page: Page,
): Promise<{ first: string; requests: number; second: string }> {
  const probePath = "/__module-refetch-probe.js";
  let requests = 0;
  await page.goto(`${origin}/other`);
  await page.route(
    (url) => url.pathname === probePath,
    async (route) => {
      requests += 1;
      if (requests === 1) {
        await route.abort("connectionreset");
      } else {
        await route.fulfill({ body: "export default 1;", contentType: "text/javascript" });
      }
    },
  );
  const outcomes = await page.evaluate(async (probe) => {
    const attempt = () =>
      import(/* @vite-ignore */ probe).then(
        () => "ok",
        () => "failed",
      );
    return { first: await attempt(), second: await attempt() };
  }, probePath);
  await page.unroute((url) => url.pathname === probePath);
  return { ...outcomes, requests };
}

test.describe("engine detection", () => {
  test("a failed module import is either kept or fetched again, and the probe can tell", async ({
    browser,
    page,
  }) => {
    await serve("A");
    const { first, requests, second } = await detectModuleRefetch(page);
    test.info().annotations.push({
      description: `${browser.browserType().name()} ${browser.version()}: first import ${first}, second import ${second}, ${requests} requests`,
      type: "module-refetch",
    });

    expect(first, "the injected failure should fail the first import").toBe("failed");
    // Only a second request can turn the second import into a success, so a mismatch
    // means the probe measured the route instead of the engine.
    expect(requests).toBe(second === "ok" ? 2 : 1);
  });
});

test.describe("stale tab after a deploy", () => {
  test.beforeEach(async () => {
    await serve("A");
  });

  test("1a. a module-level action runs on the new build, then one document load follows", async ({
    page,
  }) => {
    const tab = await openTab(page, "/");
    await serve("B");

    const actionResponse = page.waitForResponse(
      (response) => response.request().method() === "POST",
    );
    await page.locator("#run-action").click();
    const response = await actionResponse;
    expect(response.status()).toBe(200);
    expect(response.headers()[COMPATIBILITY_HEADER]).toBeTruthy();

    await expectDocumentLoads(tab, 1);
    expect(await readActionRuns("B")).toEqual(["ping:B"]);
    await expect(page.locator("#version")).toHaveText("Version B");

    await page.locator("#run-action").click();
    await expect(page.locator("#action-result")).toHaveText("pong:B");
    expect(await tab.documentLoads()).toBe(1);
    expect(await readActionRuns("B")).toEqual(["ping:B", "ping:B"]);
  });

  test("1b. a closure-bound action does not run, and one document load follows", async ({
    page,
  }) => {
    const tab = await openTab(page, "/");
    await serve("B");

    await page.locator("#run-bound").click();
    await expectDocumentLoads(tab, 1);
    expect(await readActionRuns("B")).toEqual([]);
    await expect(page.locator("#version")).toHaveText("Version B");
    await expect(page.locator("#action-result")).toHaveText("idle");
  });

  test("2. a viewport prefetch triggers no load and no old chunk request, and the click lands on the target", async ({
    page,
  }) => {
    const tab = await openTab(page, "/");
    const oldWidget = await findChunkPath("A", { marker: "PREFETCH_WIDGET_MARKER" });
    await page.locator("#draft").fill("typed before the deploy");
    await serve("B");

    const prefetch = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/prefetch-target" &&
        response.request().headers().rsc === "1",
    );
    await page.locator("#prefetch-link").scrollIntoViewIfNeeded();
    expect((await prefetch).headers()[COMPATIBILITY_HEADER]).toBeTruthy();
    await page.waitForTimeout(1_500);

    expect(await tab.documentLoads()).toBe(0);
    await expect(page.locator("#draft")).toHaveValue("typed before the deploy");
    expect(tab.requests.map((request) => new URL(request.url).pathname)).not.toContain(oldWidget);
    expect(tab.requests.filter((request) => request.status >= 400)).toEqual([]);
    expect(tab.headProbes).toEqual([]);

    await page.locator("#prefetch-link").click();
    await expectDocumentLoads(tab, 1);
    await expect(page).toHaveURL(`${origin}/prefetch-target`);
    await expect(page.locator("#target")).toHaveText("Prefetch target B");
  });

  test("6. offline: a render-time failure surfaces with no load, and recovers once back online", async ({
    context,
    page,
  }) => {
    const tab = await openTab(page, "/stale-dynamic");
    await serve("B");

    await context.setOffline(true);
    await page.locator("#show-widget").click();
    await expect(page.locator("#error-boundary")).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(await tab.documentLoads()).toBe(0);

    await context.setOffline(false);
    await page.locator("#reset").click();
    await page.locator("#show-widget").click();
    await expectDocumentLoads(tab, 1);
    await expect(page.locator("#target")).toHaveText("Stale dynamic B");
    expectProbesOnEntry(tab);
  });

  test("8. a compatibility reload on a URL with a fragment loads a document, and refreshes keep working", async ({
    page,
  }) => {
    const tab = await openTab(page, "/#x");
    await serve("B");

    await page.locator("#refresh").click();
    await expectDocumentLoads(tab, 1);
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.locator("#version")).toHaveText("Version B");

    await waitForAppRouterHydration(page);
    const refresh = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/" && response.request().headers().rsc === "1",
    );
    await page.locator("#refresh").click();
    expect((await refresh).status()).toBe(200);
    await page.waitForTimeout(1_500);
    expect(await tab.documentLoads()).toBe(1);
  });

  test("10a. next/dynamic after a deploy recovers with one load", async ({ page }) => {
    const tab = await openTab(page, "/stale-dynamic");
    await serve("B");

    await page.locator("#show-widget").click();
    await expectDocumentLoads(tab, 1);
    await expect(page.locator("#target")).toHaveText("Stale dynamic B");
    expectProbesOnEntry(tab);
  });

  test("15. an app-authored React.lazy import recovers after a deploy", async ({ page }) => {
    const tab = await openTab(page, "/react-lazy");
    await serve("B");

    await page.locator("#show-lazy").click();
    await expectDocumentLoads(tab, 1);
    await expect(page.locator("#target")).toHaveText("React lazy B");
    expectProbesOnEntry(tab);
  });

  test("15b. a React.lazy import with no dependency chunks recovers too", async ({ page }) => {
    const tab = await openTab(page, "/react-lazy");
    await serve("B");

    await page.locator("#show-bare").click();
    await expectDocumentLoads(tab, 1);
    await expect(page.locator("#target")).toHaveText("React lazy B");
    expectProbesOnEntry(tab);
  });

  test("9. a canceled Leave-site prompt shows one dialog, rejects the waiting caller and resumes the queue", async ({
    browserName,
    page,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    const tab = await openTab(page, "/stale-dynamic");
    await page.evaluate(() => {
      Reflect.set(window, "__blockUnload", true);
      window.addEventListener("beforeunload", (event) => {
        if (!Reflect.get(window, "__blockUnload")) return;
        event.preventDefault();
        event.returnValue = "";
      });
    });
    // Browsers show the prompt only after the user has interacted with the page.
    await page.locator("#draft").click();
    await serve("B");

    const startedAt = Date.now();
    await page.locator("#show-widget").click();
    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: recovery.DOCUMENT_UNLOAD_TIMEOUT_MS + 10_000,
    });
    const waited = Date.now() - startedAt;
    expect(dialogs).toEqual(["beforeunload"]);
    expect(await tab.documentLoads()).toBe(0);
    if (browserName === "chromium") {
      expect(waited, "a confirmed cancel settles before the unload timeout").toBeLessThan(
        recovery.DOCUMENT_UNLOAD_TIMEOUT_MS,
      );
    } else {
      expect(
        waited,
        "the unload timeout settles a cancel the browser never reports",
      ).toBeGreaterThan(recovery.DOCUMENT_UNLOAD_TIMEOUT_MS - 1_000);
    }

    await page.evaluate(() => Reflect.set(window, "__blockUnload", false));
    const refresh = page.waitForRequest((request) => request.headers().rsc === "1", {
      timeout: recovery.DOCUMENT_UNLOAD_TIMEOUT_MS + 5_000,
    });
    await page.evaluate(() => {
      const router = window.next!.router!;
      if (!("refresh" in router)) throw new Error("Expected the App Router");
      router.refresh();
    });
    await refresh;
    // A confirmed cancel releases the loop guard, so the refresh's compatibility reload loads
    // the new build. An expiry keeps the guard, because the abandoned load may still be under
    // way, and refuses that reload once.
    await expectDocumentLoads(tab, browserName === "chromium" ? 1 : 0);
    expect(dialogs).toEqual(["beforeunload"]);
  });

  test("10b. a failing Promise-form next/dynamic loader surfaces its error and loads nothing", async ({
    page,
  }) => {
    await serve("A");
    const tab = await openTab(page, "/stale-dynamic");

    await page.locator("#show-promise-form").click();
    await expect(page.locator("#error-message")).toContainText("PROMISE_FORM_FAILURE");
    await expectDocumentLoads(tab, 0);
    expectProbesOnEntry(tab);
  });

  test("12a. a recovery waits for a pending document navigation instead of replacing it", async ({
    browserName,
    page,
  }) => {
    const tab = await openTab(page, "/stale-dynamic");
    await serve("B");

    // The gateway holds the document response, so the navigation stays pending.
    delayNextRequest("/slow-doc", 3_000);
    // Page code cannot be evaluated once the navigation starts, so the link arms the failing render.
    await page.evaluate(() => {
      document.querySelector("#slow-link")!.addEventListener("click", () => {
        setTimeout(() => document.querySelector<HTMLButtonElement>("#show-widget")!.click(), 200);
      });
    });
    await page.locator("#slow-link").click({ noWaitAfter: true });
    await expect(page.locator("#slow-target")).toHaveText("Slow document B", { timeout: 20_000 });
    await page.waitForTimeout(1_500);

    await expect(page).toHaveURL(`${origin}/slow-doc`);
    expect(tab.navigations).toEqual(["/stale-dynamic", "/slow-doc"]);
    // WebKit cancels the old document's fetches once a navigation starts, so its probe never
    // reaches the network. The outcome is the same: no recovery load replaces the navigation.
    if (browserName === "chromium") expectProbesOnEntry(tab);
  });

  test("14. an attachment Link click leaves the page alive, and the next press runs within the unload timeout", async ({
    page,
  }) => {
    await serve("A");
    const tab = await openTab(page, "/");

    const download = page.waitForEvent("download");
    await page.locator("#csv-link").click();
    await download;

    const pressedAt = Date.now();
    await page.locator("#run-action").click();
    await expect(page.locator("#action-result")).toHaveText("pong:A", {
      timeout: recovery.DOCUMENT_UNLOAD_TIMEOUT_MS + 5_000,
    });
    expect(Date.now() - pressedAt).toBeLessThan(recovery.DOCUMENT_UNLOAD_TIMEOUT_MS + 2_000);
    expect(await tab.documentLoads()).toBe(0);
  });
});

test.describe("a live build with a chunk that fails to load", () => {
  test.beforeEach(async () => {
    await serve("A");
  });

  async function clickClientLinkWithBrokenBuild(page: Page, tab: Tab) {
    const faults = createFaults(page);
    await faults.breakChunk(await findChunkPath("A", { marker: "CLIENT_WIDGET_MARKER" }), "404");
    await faults.breakEntryProbe(tab.entryUrl);
    const historyLength = await page.evaluate(() => window.history.length);
    await page.locator("#client-link").click();
    await expectDocumentLoads(tab, 1);
    return { faults, historyLength };
  }

  test("3. a replaced build costs one load to the link target, one history entry, and Back returns", async ({
    page,
  }) => {
    const tab = await openTab(page, "/");
    const { faults, historyLength } = await clickClientLinkWithBrokenBuild(page, tab);

    await expect(page).toHaveURL(`${origin}/client-target`);
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength + 1);
    expectProbesOnEntry(tab);

    await faults.unroute();
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.locator("#version")).toHaveText("Version A");
  });

  test("3a. the recovered document renders the target's client component", async ({
    browserName,
    page,
  }) => {
    test.fixme(
      browserName === "webkit",
      "WebKit serves the failed module again after location.replace to the same URL; see the T5 report",
    );
    const tab = await openTab(page, "/");
    await clickClientLinkWithBrokenBuild(page, tab);
    await expect(page.locator("#widget")).toHaveText("CLIENT_WIDGET_MARKER A");
    expect(
      await tab.errorUiDocuments(),
      "the recovered document never showed the error UI",
    ).not.toContain(2);
  });

  test("3b. a hydration-time chunk failure shows no error UI and costs one load", async ({
    browserName,
    page,
  }) => {
    const faults = createFaults(page, { skipNavigations: 1 });
    await faults.breakChunk(await findChunkPath("A", { marker: "HYDRATE_WIDGET_MARKER" }), "404");
    await faults.breakEntryProbe(`${origin}${sites.A.entryPath}`);
    const tab = await openTab(page, "/hydrate-target", { hydration: "none" });

    await expectDocumentLoads(tab, 1);
    expect(
      await tab.errorUiDocuments(),
      "the first document never showed the error UI",
    ).not.toContain(1);
    expectProbesOnEntry(tab);
    if (browserName === "webkit") return;
    await waitForAppRouterHydration(page);
    await expect(page.locator("#widget")).toHaveText("HYDRATE_WIDGET_MARKER A 0");
    expect(await tab.errorUiDocuments()).toEqual([]);
  });

  test("4. a transient failure costs one load where the engine keeps failed modules, and none where it fetches again", async ({
    context,
    page,
  }) => {
    const detection = await context.newPage();
    const { second } = await detectModuleRefetch(detection);
    await detection.close();
    const refetches = second === "ok";

    const tab = await openTab(page, "/");
    cutNextResponses(await findChunkPath("A", { marker: "CLIENT_WIDGET_MARKER" }));
    await page.locator("#client-link").click();

    await expectDocumentLoads(tab, refetches ? 0 : 1);
    await expect(page).toHaveURL(`${origin}/client-target`);
    if (refetches) {
      expect(tab.headProbes).toEqual([]);
    } else {
      expectProbesOnEntry(tab);
    }
  });

  test("4a. the transient failure heals and the target renders its client component", async ({
    browserName,
    context,
    page,
  }) => {
    const detection = await context.newPage();
    const { second } = await detectModuleRefetch(detection);
    await detection.close();
    test.fixme(
      second !== "ok" && browserName === "webkit",
      "WebKit serves the failed module again after location.replace to the same URL; see the T5 report",
    );

    const tab = await openTab(page, "/");
    cutNextResponses(await findChunkPath("A", { marker: "CLIENT_WIDGET_MARKER" }));
    await page.locator("#client-link").click();

    await expect(page.locator("#widget")).toHaveText("CLIENT_WIDGET_MARKER A");
    expect(
      await tab.errorUiDocuments(),
      "the recovered document never showed the error UI",
    ).not.toContain(2);
  });

  test("5. a chunk missing from the live build costs one load, then the error surfaces with no more", async ({
    page,
  }) => {
    const tab = await openTab(page, "/");
    const faults = createFaults(page, { healOnNavigation: false });
    await faults.breakChunk(await findChunkPath("A", { marker: "CLIENT_WIDGET_MARKER" }), "404");
    await page.locator("#client-link").click();

    await expect(page.locator("#error-boundary")).toBeVisible();
    await expectDocumentLoads(tab, 1);
    await page.waitForTimeout(3_000);
    expect(await tab.documentLoads()).toBe(1);
    expectProbesOnEntry(tab);
    expect(tab.consoleMessages).toContainEqual({ text: recovery.REFUSED_MESSAGE, type: "error" });
  });

  test("7. a client component that throws while evaluating surfaces its error with no load", async ({
    page,
  }) => {
    const tab = await openTab(page, "/");
    await page.locator("#eval-link").click();

    await expect(page.locator("#error-message")).toContainText("EVAL_WIDGET_EVALUATION_FAILURE");
    await expectDocumentLoads(tab, 0);
    expect(tab.headProbes).toEqual([]);
  });
});

test.describe("hybrid app with client rewrites", () => {
  let ownerChunkPath = "";

  test.beforeEach(async () => {
    await serve("hybrid");
    ownerChunkPath = await findChunkPath("hybrid", { namePrefix: "hybrid-client-route-owner-" });
  });

  test("11a. a route owner chunk and an entry that answer 404 at startup cost one load", async ({
    page,
  }) => {
    const faults = createFaults(page, { skipNavigations: 1 });
    await faults.breakChunk(ownerChunkPath, "404");
    await faults.breakEntryProbe(`${origin}${sites.hybrid.entryPath}`);
    const tab = await openTab(page, "/", { hydration: "none" });

    await expectDocumentLoads(tab, 1);
    expect(tab.navigations).toEqual(["/", "/"]);
    expectProbesOnEntry(tab);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#version")).toHaveText("Version A");
  });

  test("11b. a Link whose route owner chunk fails loads its target as a document", async ({
    page,
  }) => {
    const faults = createFaults(page, { healOnNavigation: false });
    await faults.breakChunk(ownerChunkPath, "404");
    const tab = await openTab(page, "/", { hydration: "none" });
    // Startup spends the tab's one guarded load for this failure, then hydrates without the owner.
    await expectDocumentLoads(tab, 1);
    await waitForAppRouterHydration(page);

    await page.locator("#other-link").click();
    await expectDocumentLoads(tab, 2);
    expect(tab.navigations).toEqual(["/", "/", "/other"]);
    await expect(page).toHaveURL(`${origin}/other`);
    await expect(page.locator("#other")).toHaveText("this is other A");
  });

  test("11c. Router.push on a Pages page navigates by document when the route owner chunk fails", async ({
    page,
  }) => {
    const faults = createFaults(page, { healOnNavigation: false });
    await faults.breakChunk(ownerChunkPath, "404");
    const tab = await openTab(page, "/legacy", { hydration: "pages" });

    await page.locator("#push-other").click();
    // The first load of /other is the push falling back to a document navigation. The second is
    // the App Router page recovering from the same missing chunk at startup, after which the
    // tab's claim is spent and it hydrates without the owner.
    await expectDocumentLoads(tab, 2);
    expect(tab.navigations).toEqual(["/legacy", "/other", "/other"]);
    await expect(page).toHaveURL(`${origin}/other`);
    await expect(page.locator("#other")).toHaveText("this is other A");
  });
});

test.describe("12. navigating away", () => {
  test.beforeEach(async () => {
    await serve("A");
  });

  test("a lazy chunk that is still loading when the page navigates away logs nothing", async ({
    page,
  }) => {
    const faults = createFaults(page, { healOnNavigation: false });
    await faults.breakChunk(
      await findChunkPath("A", { marker: "this is a lazy loaded async component" }),
      "hold",
    );
    const tab = await openTab(page, "/dynamic", { hydration: "none" });

    try {
      await page.goto(`${origin}/other`);
      await expect(page.locator("body")).toContainText("this is other");
      // Chrome and Safari report no error or warning for a chunk aborted by navigation.
      expect(
        tab.consoleMessages.filter(({ type }) => type === "warning" || type === "error"),
      ).toEqual([]);
    } finally {
      await faults.unroute();
    }
  });
});

test.describe("ported from Next.js chunk-load-failure", () => {
  test.beforeEach(async () => {
    await serve("A");
  });

  test("should report async chunk load failures", async ({ page }) => {
    const faults = createFaults(page, { healOnNavigation: false });
    await faults.breakChunk(
      await findChunkPath("A", { marker: "this is a lazy loaded async component" }),
      "abort",
    );
    const tab = await openTab(page, "/dynamic", { hydration: "none" });

    await expect(page.locator("#error-boundary")).toBeVisible();
    await expect(page.locator("#error-message")).toContainText(
      /dynamically imported module|Importing a module script failed/,
    );
    expect(faults.chunkRequests).toHaveLength(1);
    // A user next/dynamic loader is not retried and the build is live, so nothing reloads.
    await expectDocumentLoads(tab, 0);
    expectProbesOnEntry(tab);
  });

  // Turbopack-only upstream: it retries a failed chunk once, so a transient failure heals.
  // vinext does not retry user next/dynamic loaders, which matches the webpack behavior the
  // case above pins, so this case has no counterpart here.
  test.skip("should recover after a transient async chunk load failure", () => {});
});

test.describe("a stale page restored from the back/forward cache", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Native Chromium BFCache behavior");

  test("13. recovers with one load when a render needs a chunk the new build no longer has", async ({
    page,
  }) => {
    await serve("A");
    const tab = await openTab(page, "/stale-dynamic");
    await page.evaluate(() => {
      Reflect.set(window, "__restored", false);
      window.addEventListener("pageshow", (event) => {
        Reflect.set(window, "__restored", event.persisted);
      });
    });

    await page.goto(`${origin}/other`);
    await serve("B");
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "__restored"))).toBe(true);
    const loadsBefore = await tab.documentLoads();

    await page.locator("#show-widget").click();
    await expect.poll(() => tab.documentLoads(), { timeout: 20_000 }).toBe(loadsBefore + 1);
    await expect(page.locator("#target")).toHaveText("Stale dynamic B");
    await page.waitForTimeout(1_500);
    expect(await tab.documentLoads()).toBe(loadsBefore + 1);
    expectProbesOnEntry(tab);
  });
});
