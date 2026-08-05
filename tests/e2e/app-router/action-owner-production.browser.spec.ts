import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createBuilder } from "vite";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";
import { waitForAppRouterHydration } from "../helpers";

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/app-action-ownership");

type ProductionApp = {
  actionIds: {
    adminOnly: string;
    adminShared: string;
    boundaryOnly: string;
    cookieOwner: string;
    dynamicProtected: string;
    globalErrorOnly: string;
    globalNotFoundOnly: string;
    loop: string;
    packageClient: string;
    protected: string;
    protectedClient: string;
    redirectTo: string;
    sameNameSubmit: string;
    sideEffectSecret: string;
  };
  deleteAccountIds: string[];
  baseUrl: string;
  fixtureRoot: string;
  offlineProtectedActionId: string;
  server: ChildProductionServer;
};

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const sourceNodeModules = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
  const targetNodeModules = path.join(fixtureRoot, "node_modules");
  await fs.mkdir(targetNodeModules, { recursive: true });
  for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".vite" || entry.name === ".vite-temp") continue;
    await fs.symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
  await fs.symlink(
    path.join(fixtureRoot, "action-client-package"),
    path.join(targetNodeModules, "action-client-package"),
    "junction",
  );
}

async function readBuiltJavaScript(directory: string): Promise<string> {
  let output = "";
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output += await readBuiltJavaScript(entryPath);
    else if (entry.name.endsWith(".js")) output += await fs.readFile(entryPath, "utf8");
  }
  return output;
}

function findActionId(source: string, exportName: string): string {
  const escapedExportName = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`["'\`]([0-9a-f]{12})["'\`]\\s*,\\s*["'\`]${escapedExportName}["'\`]`),
  );
  if (!match) throw new Error(`Missing built action id for ${exportName}`);
  return `${match[1]}#${exportName}`;
}

function findActionIds(source: string, exportName: string): string[] {
  const escapedExportName = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...source.matchAll(
      new RegExp(`["'\`]([0-9a-f]{12})["'\`]\\s*,\\s*["'\`]${escapedExportName}["'\`]`, "g"),
    ),
  ].map((match) => `${match[1]}#${exportName}`);
  if (matches.length === 0) throw new Error(`Missing built action id for ${exportName}`);
  return [...new Set(matches)];
}

async function buildAndServeFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-action-owner-e2e-"));
  await fs.cp(FIXTURE_DIR, fixtureRoot, { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);

  const vinext = (await import("../../../packages/vinext/src/index.js")).default;
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: false,
    plugins: [vinext({ appDir: fixtureRoot })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const builtSource = await readBuiltJavaScript(path.join(fixtureRoot, "dist", "server"));
  const protectedActionPath = await fs.realpath(
    path.join(fixtureRoot, "app/ownership/report/admin/actions.ts"),
  );
  const server = await startChildProductionServer(fixtureRoot);
  return {
    actionIds: {
      adminOnly: findActionId(builtSource, "$$hoist_0_adminOnly"),
      adminShared: findActionId(builtSource, "adminSharedAction"),
      boundaryOnly: findActionId(builtSource, "boundaryOnlyAction"),
      cookieOwner: findActionId(builtSource, "$$hoist_0_readForwardedCredentials"),
      dynamicProtected: findActionId(builtSource, "$$hoist_0_dynamicProtectedAction"),
      globalErrorOnly: findActionId(builtSource, "globalErrorOnlyAction"),
      globalNotFoundOnly: findActionId(builtSource, "globalNotFoundOnlyAction"),
      loop: findActionId(builtSource, "$$hoist_0_loopAction"),
      packageClient: findActionId(builtSource, "packageClientAction"),
      protected: findActionId(builtSource, "protectedAction"),
      protectedClient: findActionId(builtSource, "protectedClientAction"),
      redirectTo: findActionId(builtSource, "redirectTo"),
      sameNameSubmit: findActionId(builtSource, "submit"),
      sideEffectSecret: findActionId(builtSource, "sideEffectSecretAction"),
    },
    baseUrl: `http://127.0.0.1:${server.port}`,
    deleteAccountIds: findActionIds(builtSource, "$$hoist_0_deleteAccount"),
    fixtureRoot,
    offlineProtectedActionId: `${createHash("sha256")
      .update(path.relative(fixtureRoot, protectedActionPath))
      .digest("hex")
      .slice(0, 12)}#protectedAction`,
    server,
  };
}

async function executeAction(page: Page, route: string, id: string) {
  await page.goto(`${app.baseUrl}/ownership/${route}`);
  await waitForAppRouterHydration(page);
  await page.getByTestId(id).click();
  return page.getByTestId(`${id}-result`);
}

async function postAction(page: Page, pathname: string, actionId: string, args: unknown[] = []) {
  await page.goto(`${app.baseUrl}${pathname}`);
  return page.evaluate(
    async ({ actionId, args, pathname }) => {
      const response = await fetch(pathname, {
        body: JSON.stringify(args),
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "next-action": actionId,
        },
        method: "POST",
      });
      return {
        body: await response.text(),
        headers: Object.fromEntries(response.headers),
        status: response.status,
      };
    },
    { actionId, args, pathname },
  );
}

async function postRawAction(
  page: Page,
  pathname: string,
  actionId: string,
  body: string,
  contentType: string,
) {
  await page.goto(`${app.baseUrl}${pathname}`);
  return page.evaluate(
    async ({ actionId, body, contentType, pathname }) => {
      const response = await fetch(pathname, {
        body,
        headers: { "content-type": contentType, "next-action": actionId },
        method: "POST",
      });
      return {
        body: await response.text(),
        headers: Object.fromEntries(response.headers),
        status: response.status,
      };
    },
    { actionId, body, contentType, pathname },
  );
}

async function postProgressiveAction(
  page: Page,
  pathname: string,
  actionId: string,
  earlierActionIds: string[] = [],
) {
  await page.goto(`${app.baseUrl}${pathname}`);
  return page.evaluate(
    async ({ actionId, earlierActionIds, pathname }) => {
      const body = new FormData();
      for (const earlierActionId of earlierActionIds) {
        body.append(`$ACTION_ID_${earlierActionId}`, "");
      }
      body.set(`$ACTION_ID_${actionId}`, "");
      const response = await fetch(pathname, { body, method: "POST" });
      return { body: await response.text(), status: response.status };
    },
    { actionId, earlierActionIds, pathname },
  );
}

async function postRenderedProgressiveForm(
  page: Page,
  sourcePathname: string,
  targetPathname: string,
) {
  await page.goto(`${app.baseUrl}${sourcePathname}`);
  return page.evaluate(async (targetPathname) => {
    const form = document.querySelector("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Missing progressive action form");
    const response = await fetch(targetPathname, { body: new FormData(form), method: "POST" });
    return { body: await response.text(), status: response.status };
  }, targetPathname);
}

let app: ProductionApp;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  app = await buildAndServeFixture();
});

test.afterAll(async () => {
  if (!app) return;
  await stopChildProductionServer(app.server);
  await fs.rm(app.fixtureRoot, { recursive: true, force: true });
});

test.setTimeout(60_000);

test.describe("production server action ownership", () => {
  test("executes actions through every supported ownership topology", async ({ page }) => {
    const cases = [
      ["direct", "direct", "DIRECT_OK"],
      ["alias", "alias", "ALIAS_OK"],
      ["barrel", "barrel", "BARREL_OK"],
      ["star", "star", "STAR_OK"],
      ["namespace", "namespace", "NAMESPACE_OK"],
      ["namespace-barrel", "namespace-barrel", "NAMESPACE_BARREL_OK"],
      ["dynamic", "dynamic", "DYNAMIC_OK"],
      ["default", "default", "DEFAULT_OK"],
      ["cycle", "cycle", "CYCLE_OK"],
      ["client", "client", "CLIENT_OK"],
      ["client-form", "client-form", "CLIENT_FORM_OK:nested"],
      ["object-wrapped", "object-wrapped", "OBJECT_WRAPPED_OK"],
      ["imported-inline", "imported-inline", "IMPORTED_INLINE_OK"],
      ["route-inline", "route-inline", "ROUTE_INLINE_OK"],
      ["layout-owner", "layout-owner", "LAYOUT_OK"],
      ["public", "public", "PUBLIC_OK"],
      ["duplicate", "duplicate-first", "DUPLICATE_FIRST_OK"],
      ["duplicate", "duplicate-second", "DUPLICATE_SECOND_OK"],
      ["mixed", "mixed-static", "MIXED_STATIC_OK"],
      ["mixed", "mixed-dynamic", "MIXED_DYNAMIC_OK"],
      ["report/dynamic/example", "dynamic-protected", "DYNAMIC_PROTECTED_ACTION_EXECUTED"],
      ["report/shared", "public-shared", "PUBLIC_SHARED_ACTION_EXECUTED"],
      ["same-name/action-owner", "same-name-action", "SAME_NAME_ACTION_OK:distinct"],
    ] as const;

    const expectedAssertions = 23;
    let completedAssertions = 0;
    for (const [route, id, expected] of cases) {
      await expect(await executeAction(page, route, id)).toHaveText(expected);
      completedAssertions++;
    }
    if (completedAssertions !== expectedAssertions) {
      throw new Error(
        `Expected ${expectedAssertions} action assertions, completed ${completedAssertions}`,
      );
    }
  });

  test("associates every reference exported by a reachable action module", async ({ page }) => {
    const directOwnerResponse = await page.goto(`${app.baseUrl}/ownership/admin`);
    expect(directOwnerResponse?.status()).toBe(401);
    await expect(page.locator("body")).toHaveText("ADMIN_BLOCKED");

    await page.goto(`${app.baseUrl}/ownership/public`);
    const response = await page.evaluate(
      async ({ actionId }) => {
        const result = await fetch("/ownership/public", {
          body: "[]",
          headers: {
            "content-type": "text/plain;charset=UTF-8",
            "next-action": actionId,
          },
          method: "POST",
        });
        return { body: await result.text(), status: result.status };
      },
      { actionId: app.actionIds.adminOnly },
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain("ADMIN_ONLY_EXECUTED");
  });

  test("re-enters protected owner middleware for forged public-path requests", async ({ page }) => {
    const directOwnerResponse = await page.goto(`${app.baseUrl}/ownership/report/admin`);
    expect(directOwnerResponse?.status()).toBe(401);
    await expect(page.locator("body")).toHaveText("ADMIN_BLOCKED");

    const response = await postAction(page, "/ownership/report/public", app.actionIds.protected);
    expect(response.status).toBe(200);
    expect(response.body).toBe("{}");
    expect(response.body).not.toContain("PROTECTED_ACTION_EXECUTED");
  });

  test("routes progressive actions through protected owner middleware", async ({ page }) => {
    const response = await postProgressiveAction(
      page,
      "/ownership/report/public",
      app.actionIds.adminOnly,
    );
    expect(response.status).toBe(200);
    expect(response.body).not.toContain("ADMIN_ONLY_EXECUTED");
  });

  test("routes progressive actions using React's last action field", async ({ page }) => {
    const response = await postProgressiveAction(
      page,
      "/ownership/report/public",
      app.actionIds.adminOnly,
      [app.actionIds.redirectTo],
    );
    expect(response.status).toBe(200);
    expect(response.body).not.toContain("ADMIN_ONLY_EXECUTED");
  });

  test("routes bound progressive actions before loading their modules", async ({ page }) => {
    const response = await postRenderedProgressiveForm(
      page,
      "/ownership/same-name/action-owner",
      "/ownership/same-name/helper-only",
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("{}");
    expect(response.body).not.toContain("SAME_NAME_ACTION_OK");
  });

  test("retains protected ownership through client component boundaries", async ({ page }) => {
    const directOwnerResponse = await page.goto(`${app.baseUrl}/ownership/report/client-owner`);
    expect(directOwnerResponse?.status()).toBe(401);

    const response = await postAction(
      page,
      "/ownership/report/public",
      app.actionIds.protectedClient,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("{}");
    expect(response.body).not.toContain("PROTECTED_CLIENT_ACTION_EXECUTED");
  });

  test("keeps offline-computable production action ids harmless", async ({ page }) => {
    expect(app.offlineProtectedActionId).toBe(app.actionIds.protected);

    const response = await postAction(
      page,
      "/ownership/report/public",
      app.offlineProtectedActionId,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("{}");
    expect(response.body).not.toContain("PROTECTED_ACTION_EXECUTED");
  });

  test("does not inline middleware-gated redirect targets", async ({ page }) => {
    const directTarget = await page.goto(`${app.baseUrl}/ownership/report/admin/secret`);
    expect(directTarget?.status()).toBe(401);
    await expect(page.locator("body")).toHaveText("ADMIN_BLOCKED");

    const response = await postAction(page, "/ownership/report/public", app.actionIds.redirectTo, [
      "/ownership/report/admin/secret",
    ]);
    expect(response.status).toBe(303);
    expect(response.headers["x-action-redirect"]).toBe("/ownership/report/admin/secret");
    expect(response.body).toBe("");
    expect(response.body).not.toContain("ADMIN_SECRET_MARKER_42");
  });

  test("preserves external redirects from forwarded action owners", async ({ page }) => {
    const response = await postAction(page, "/ownership/report/shared", app.actionIds.redirectTo, [
      "https://example.com/destination",
    ]);
    expect(response.status).toBe(303);
    expect(response.headers["x-action-redirect"]).toBe("https://example.com/destination");
    expect(response.body).toBe("");
  });

  test("blocks encrypted closure replay across actions", async ({ page }) => {
    await page.goto(`${app.baseUrl}/ownership/report/oracle?value=victim-carol`);
    await waitForAppRouterHydration(page);
    const oracleRequestPromise = page.waitForRequest(
      (request) => request.method() === "POST" && Boolean(request.headers()["next-action"]),
    );
    await page.getByTestId("oracle").click();
    await expect(page.getByTestId("oracle-result")).toHaveText("ORACLE:victim-carol");
    const oracleRequest = await oracleRequestPromise;
    const replayBody = oracleRequest.postData();
    const contentType = oracleRequest.headers()["content-type"];
    expect(replayBody).not.toBeNull();
    expect(contentType).toBeTruthy();

    for (const actionId of app.deleteAccountIds) {
      const response = await postRawAction(
        page,
        "/ownership/report/public",
        actionId,
        replayBody!,
        contentType!,
      );
      expect(response.status).toBe(200);
      expect(response.headers["x-action-redirect"]).toBeUndefined();
      expect(response.body).toBe("{}");
      expect(response.body).not.toContain("ADMIN_SECRET_MARKER_42");
      expect(response.body).not.toContain("victim-carol");
    }
  });

  test("uses module-level ownership for shared action modules", async ({ page }) => {
    const directAdminOwner = await page.goto(`${app.baseUrl}/ownership/report/admin/shared`);
    expect(directAdminOwner?.status()).toBe(401);
    const response = await postAction(page, "/ownership/report/shared", app.actionIds.adminShared);
    expect(response.status).toBe(200);
    expect(response.body).toContain("ADMIN_SHARED_ACTION_EXECUTED");
  });

  test("keeps same-named non-action exports isolated from action ownership", async ({ page }) => {
    await page.goto(`${app.baseUrl}/ownership/same-name/action-owner`);
    await expect(page.getByTestId("same-name-helper-result")).toHaveText("SAME_NAME_HELPER_OK");

    await page.goto(`${app.baseUrl}/ownership/same-name/helper-only`);
    await expect(page.getByTestId("same-name-helper-result")).toHaveText("SAME_NAME_HELPER_OK");
    const response = await postAction(
      page,
      "/ownership/same-name/helper-only",
      app.actionIds.sameNameSubmit,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("{}");
    expect(response.body).not.toContain("SAME_NAME_ACTION_OK");
  });

  test("forwards dynamic owners using their route pattern", async ({ page }) => {
    const response = await postAction(
      page,
      "/ownership/report/public",
      app.actionIds.dynamicProtected,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("{}");
    expect(response.body).not.toContain("DYNAMIC_PROTECTED_ACTION_EXECUTED");
  });

  test("propagates middleware request headers and response cookies", async ({ page }) => {
    const response = await postAction(
      page,
      "/ownership/report/cookie-source",
      app.actionIds.cookieOwner,
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain("trusted:present");
  });

  test("stops recursive forwarding after an owner rewrite", async ({ page }) => {
    const response = await postAction(page, "/ownership/report/public", app.actionIds.loop);
    expect(response.status).toBe(200);
    expect(response.body).toBe("{}");
    expect(response.body).not.toContain("LOOP_ACTION_EXECUTED");
  });

  test("fails closed for unknown action ids", async ({ page }) => {
    await page.goto(`${app.baseUrl}/ownership/direct`);
    const status = await page.evaluate(async () => {
      const response = await fetch("/ownership/direct", {
        body: "[]",
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "next-action": "000000000000#missing",
        },
        method: "POST",
      });
      return response.status;
    });
    expect(status).toBe(404);
  });

  test("includes server-reference modules reached by side-effect imports", async ({ page }) => {
    await page.goto(`${app.baseUrl}/ownership/side-effect`);
    const response = await page.evaluate(
      async ({ actionId }) => {
        const result = await fetch("/ownership/side-effect", {
          body: "[]",
          headers: {
            "content-type": "text/plain;charset=UTF-8",
            "next-action": actionId,
          },
          method: "POST",
        });
        return { body: await result.text(), status: result.status };
      },
      { actionId: app.actionIds.sideEffectSecret },
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain("SIDE_EFFECT_SECRET_EXECUTED");
  });

  test("includes server references reached only through route boundaries", async ({ page }) => {
    const response = await postAction(page, "/ownership/report/public", app.actionIds.boundaryOnly);
    expect(response.status).toBe(200);
    expect(response.body).toContain("BOUNDARY_ONLY_ACTION_EXECUTED");
  });

  test("associates global error actions with every route", async ({ page }) => {
    const response = await postAction(
      page,
      "/ownership/report/public",
      app.actionIds.globalErrorOnly,
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain("GLOBAL_ERROR_ONLY_ACTION_EXECUTED");
  });

  test("associates global not-found actions with every route", async ({ page }) => {
    const response = await postAction(
      page,
      "/ownership/report/public",
      app.actionIds.globalNotFoundOnly,
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain("GLOBAL_NOT_FOUND_ONLY_ACTION_EXECUTED");
  });

  test("resolves package Client Component action owners", async ({ page }) => {
    const response = await postAction(
      page,
      "/ownership/report/public",
      app.actionIds.packageClient,
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain("PACKAGE_CLIENT_ACTION_EXECUTED");
  });
});
