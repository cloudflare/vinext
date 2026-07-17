import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createBuilder, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/middleware-matcher-auth");
const REDOS_CHILD = path.resolve(
  import.meta.dirname,
  "./fixtures/middleware-matcher-redos-child.ts",
);
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..");
const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules",
);
const execFileAsync = promisify(execFile);

const PROTECTED_PATHS = [
  "/",
  "/admin/secrets",
  "/dashboard/users",
  "/de",
  "/en/profile",
  "/docs",
  "/docs/en",
  "/docs/en/fr",
  "/manual/en",
  "/manual/en/fr",
  "/bar/secret",
  "/report.json",
  "/archive/2024-07-10",
  "/codes/ABCD",
  "/shared/abac",
  "/mixed/a1z9",
  "/shorthand/a1z9",
  "/bracket-shorthand/a1z9",
] as const;

async function assertAuthGuard(baseUrl: string): Promise<void> {
  const protectedResponses = await Promise.all(
    PROTECTED_PATHS.map(async (pathname) => {
      const response = await fetch(`${baseUrl}${pathname}`);
      return {
        pathname,
        status: response.status,
        guard: response.headers.get("x-auth-guard"),
        body: await response.text(),
      };
    }),
  );
  expect(protectedResponses.map(({ pathname, status }) => ({ pathname, status }))).toEqual(
    PROTECTED_PATHS.map((pathname) => ({ pathname, status: 403 })),
  );
  for (const { pathname, guard, body } of protectedResponses) {
    expect(guard, pathname).toBe("blocked");
    expect(body, pathname).toBe("blocked by middleware");
  }

  const publicResponse = await fetch(`${baseUrl}/public`);
  const publicBody = await publicResponse.text();
  expect(publicResponse.status, publicBody).toBe(200);
  expect(publicResponse.headers.get("x-auth-guard")).toBeNull();
  expect(publicBody).toContain("public page");

  const constrainedMiss = await fetch(`${baseUrl}/manual/de`);
  const constrainedMissBody = await constrainedMiss.text();
  expect(constrainedMiss.status, constrainedMissBody).toBe(200);
  expect(constrainedMiss.headers.get("x-auth-guard")).toBeNull();
  expect(constrainedMissBody).toContain("manual secret");

  const conditionedHeaders = {
    "x-present": "yes",
    cookie: "session=active",
  };
  const conditioned = await fetch(
    `${baseUrl}/conditioned?role=guest&role=admin&present=yes&present=&blocked=1&blocked=0`,
    { headers: conditionedHeaders },
  );
  expect(conditioned.status, await conditioned.text()).toBe(403);
  expect(conditioned.headers.get("x-auth-guard")).toBe("blocked");

  const wrongLastHas = await fetch(
    `${baseUrl}/conditioned?role=admin&role=guest&present=yes&present=&blocked=1&blocked=0`,
    { headers: conditionedHeaders },
  );
  const wrongLastHasBody = await wrongLastHas.text();
  expect(wrongLastHas.status, wrongLastHasBody).toBe(200);
  expect(wrongLastHas.headers.get("x-auth-guard")).toBeNull();
  expect(wrongLastHasBody).toContain("conditioned page");

  const wrongLastMissing = await fetch(
    `${baseUrl}/conditioned?role=guest&role=admin&present=yes&present=&blocked=0&blocked=1`,
    { headers: conditionedHeaders },
  );
  const wrongLastMissingBody = await wrongLastMissing.text();
  expect(wrongLastMissing.status, wrongLastMissingBody).toBe(200);
  expect(wrongLastMissing.headers.get("x-auth-guard")).toBeNull();
  expect(wrongLastMissingBody).toContain("conditioned page");
}

async function closeHttpServer(server: http.Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function writeMatcherFixture(root: string, matcher: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "middleware.ts"),
    `export function middleware() { return new Response("blocked", { status: 403 }) }
export const config = { matcher: ${JSON.stringify(matcher)} }
`,
  );
}

async function findTsxCli(): Promise<string> {
  const pnpmStore = path.join(WORKSPACE_ROOT, "node_modules/.pnpm");
  const entry = (await fs.readdir(pnpmStore)).find((name) => name.startsWith("tsx@"));
  if (!entry) throw new Error("tsx is not installed in the workspace dependency store");
  return path.join(pnpmStore, entry, "node_modules/tsx/dist/cli.mjs");
}

describe("valid middleware matcher auth guards", () => {
  describe("development server", () => {
    let root = "";
    let server: ViteDevServer | undefined;
    let baseUrl = "";

    beforeAll(async () => {
      root = await createIsolatedFixture(
        FIXTURE_DIR,
        "vinext-middleware-matcher-dev-",
        (source) => path.basename(source) !== "wrangler.jsonc",
      );
      ({ server, baseUrl } = await startFixtureServer(root));
    }, 30_000);

    afterAll(async () => {
      await server?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("blocks every path selected by group and constrained-repeat matchers", async () => {
      await assertAuthGuard(baseUrl);
    });
  });

  describe("built Node production server", () => {
    let root = "";
    let server: http.Server | undefined;
    let baseUrl = "";

    beforeAll(async () => {
      root = await createIsolatedFixture(
        FIXTURE_DIR,
        "vinext-middleware-matcher-node-",
        (source) => path.basename(source) !== "wrangler.jsonc",
      );
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [vinext({ appDir: root })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      const started = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir: path.join(root, "dist"),
        noCompression: true,
      });
      server = started.server;
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Middleware matcher Node fixture did not bind to a port");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
    }, 120_000);

    afterAll(async () => {
      await closeHttpServer(server);
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("blocks every path selected by group and constrained-repeat matchers", async () => {
      await assertAuthGuard(baseUrl);
    });
  });

  describe("built Cloudflare Worker", () => {
    let root = "";
    let worker: { url: Promise<URL>; dispose(): Promise<void> } | undefined;
    let baseUrl = "";

    beforeAll(async () => {
      root = await createIsolatedFixture(
        FIXTURE_DIR,
        "vinext-middleware-matcher-worker-",
        undefined,
        CLOUDFLARE_NODE_MODULES,
      );
      const cloudflarePluginPath = path.join(
        root,
        "node_modules/@cloudflare/vite-plugin/dist/index.mjs",
      );
      const { cloudflare } = (await import(pathToFileURL(cloudflarePluginPath).href)) as {
        cloudflare: (options: {
          viteEnvironment: { name: string; childEnvironments: string[] };
        }) => import("vite").Plugin;
      };
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [
          vinext({ appDir: root }),
          cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
        ],
        logLevel: "silent",
      });
      await builder.buildApp();

      const wranglerPath = path.join(root, "node_modules/wrangler/wrangler-dist/cli.js");
      const wrangler = (await import(pathToFileURL(wranglerPath).href)) as {
        unstable_startWorker(options: {
          config: string;
          dev: {
            remote: false;
            persist: false;
            logLevel: "none";
            watch: false;
            server: { port: 0 };
          };
        }): Promise<{ url: Promise<URL>; dispose(): Promise<void> }>;
      };
      worker = await wrangler.unstable_startWorker({
        config: path.join(root, "dist/server/wrangler.json"),
        dev: {
          remote: false,
          persist: false,
          logLevel: "none",
          watch: false,
          server: { port: 0 },
        },
      });
      await worker.url;
      baseUrl = (await worker.url).origin;
    }, 180_000);

    afterAll(async () => {
      await worker?.dispose();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("blocks every path selected by group and constrained-repeat matchers", async () => {
      await assertAuthGuard(baseUrl);
    });
  });
});

describe("unsafe middleware matcher rejection", () => {
  it.each([
    ["/:path(.*)*/end", /may match an empty value or path delimiter/],
    ["/:path(.*)+/end", /may match an empty value or path delimiter/],
    ["/:path((?:a+)+)", /contains nested repetition/],
    ["/:path((?:a|aa)+)", /contains ambiguous alternatives under repetition/],
    ["/:path((?:a|A)+)", /contains ambiguous alternatives under repetition/],
    ["/:path((?:a+){10})", /contains nested repetition/],
    [`/:path(${"(?:a+)".repeat(6)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+)".repeat(7)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+(?:))".repeat(6)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+(?:))".repeat(7)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+(?:))".repeat(8)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+){1}".repeat(6)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+){1}".repeat(8)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+){1,1}".repeat(6)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:(?:a+){1}){1,1}".repeat(6)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+)".repeat(8)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+)".repeat(9)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a+)".repeat(10)})`, /contains overlapping sequential repetition/],
    [`/:path(${"(?:a|aa)".repeat(26)})`, /contains ambiguous sequence expansion/],
    ["/:path(a+.*a+)", /contains overlapping sequential repetition/],
    ["/:path(a+(?:b*)a+)", /contains overlapping sequential repetition/],
  ] as const)(
    "rejects unsafe matcher %s during the build config phase",
    async (matcher, reason) => {
      const root = await createIsolatedFixture(
        FIXTURE_DIR,
        "vinext-middleware-matcher-unsafe-build-",
        (source) => path.basename(source) !== "wrangler.jsonc",
      );
      try {
        await writeMatcherFixture(root, matcher);
        await expect(
          createBuilder({
            root,
            configFile: false,
            plugins: [vinext({ appDir: root })],
            logLevel: "silent",
          }),
        ).rejects.toThrow(reason);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects an ambiguous constrained repeat during dev config processing", async () => {
    const root = await createIsolatedFixture(
      FIXTURE_DIR,
      "vinext-middleware-matcher-unsafe-dev-",
      (source) => path.basename(source) !== "wrangler.jsonc",
    );
    try {
      await writeMatcherFixture(root, "/:path(.*)*/end");
      await expect(startFixtureServer(root)).rejects.toThrow(
        /Invalid middleware matcher.*may match an empty value or path delimiter/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on ambiguous repeats without catastrophic backtracking", async () => {
    const tsxCli = await findTsxCli();
    await expect(
      execFileAsync(process.execPath, [tsxCli, REDOS_CHILD], {
        cwd: WORKSPACE_ROOT,
        timeout: 5_000,
      }),
    ).resolves.toMatchObject({
      stderr: expect.stringContaining("Middleware will run for all paths"),
      stdout: "",
    });
  });
});

describe("invalid middleware matcher object auth guards", () => {
  it("rejects an object matcher with an unsupported field before production build", async () => {
    const root = await createIsolatedFixture(
      FIXTURE_DIR,
      "vinext-middleware-matcher-invalid-object-",
      (source) => path.basename(source) !== "wrangler.jsonc",
    );
    try {
      await fs.writeFile(
        path.join(root, "middleware.ts"),
        `export function middleware() {
  return new Response("blocked by middleware", {
    status: 403,
    headers: { "x-auth-guard": "blocked" },
  })
}
export const config = {
  matcher: [{ source: "/admin/:path*", typo: true }],
}
`,
      );

      await expect(
        createBuilder({
          root,
          configFile: false,
          plugins: [vinext({ appDir: root })],
          logLevel: "silent",
        }),
      ).rejects.toThrow(/matcher object contains unsupported field "typo"/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
