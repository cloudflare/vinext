/**
 * Next.js fails the build when a module under a `"use client"` boundary
 * imports a request API (`next/headers`, `next/root-params`) or a server-only
 * `next/server` / `next/cache` API. Those modules are also evaluated during
 * SSR, where module-scope `cookies()`/`headers()` would capture the first
 * request that loads them and serve it to every later visitor.
 *
 * These builds copy checked-in App Router apps (the Cloudflare Workers example
 * and the Node fixture) and add a page rendering a Client Component that
 * imports one of those APIs. Next.js 16.2.7 fails the build for each graph
 * with both webpack and Turbopack, using the messages asserted below.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, createLogger, createServer, type Plugin } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  createInvalidClientImportMessage,
  findInvalidClientImports,
} from "../packages/vinext/src/plugins/client-graph-server-apis.js";

const CF_EXAMPLE_DIR = path.resolve(import.meta.dirname, "../examples/app-router-cloudflare");
const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-basic");
const WORKSPACE_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

const CLIENT_COMPONENT_MESSAGE =
  'into a React Client Component module. This API is only available in Server Components but one of its parents is marked with "use client", so this module is also a Client Component.';
const OUTSIDE_APP_MESSAGE =
  "This API is only available in Server Components in the App Router, but you are using it in the Pages Router.";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function copyFixture(fixtureDir: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-client-graph-apis-"));
  tmpDirs.push(root);
  fs.cpSync(fixtureDir, root, {
    recursive: true,
    filter: (source) => !/[\\/](?:node_modules|dist|\.wrangler)$/.test(source),
  });
  // The fixture's own dependencies, plus `next`, which the checked-in copy
  // resolves from the workspace root.
  const nodeModules = path.join(root, "node_modules");
  fs.mkdirSync(nodeModules);
  for (const entry of fs.readdirSync(path.join(fixtureDir, "node_modules"))) {
    fs.symlinkSync(
      path.join(fixtureDir, "node_modules", entry),
      path.join(nodeModules, entry),
      "junction",
    );
  }
  if (!fs.existsSync(path.join(nodeModules, "next"))) {
    fs.symlinkSync(
      path.join(WORKSPACE_NODE_MODULES, "next"),
      path.join(nodeModules, "next"),
      "junction",
    );
  }
  return root;
}

/** A page rendering `ClientGraphProbe`, whose module (or an import of it) is invalid. */
function writeProbePage(
  root: string,
  clientSource: string,
  extraFiles: Record<string, string> = {},
) {
  writeFile(
    root,
    "app/client-graph-probe/page.tsx",
    `import { ClientGraphProbe } from "./client-graph-probe";

export default function ClientGraphProbePage() {
  return <ClientGraphProbe />;
}
`,
  );
  writeFile(root, "app/client-graph-probe/client-graph-probe.tsx", clientSource);
  for (const [file, source] of Object.entries(extraFiles)) writeFile(root, file, source);
}

const PROBES: Array<
  [form: string, clientSource: string, extraFiles: Record<string, string>, message: string]
> = [
  [
    "next/headers imported by a Client Component",
    `"use client";

import { cookies } from "next/headers";

export function ClientGraphProbe() {
  return <p>{typeof cookies}</p>;
}
`,
    {},
    `depends on "next/headers" ${CLIENT_COMPONENT_MESSAGE}`,
  ],
  [
    "next/headers imported by a library outside app/ that a Client Component imports",
    `"use client";

import { readSession } from "../../lib/client-graph-session";

export function ClientGraphProbe() {
  return <p>{typeof readSession}</p>;
}
`,
    {
      "lib/client-graph-session.ts": `import { cookies } from "next/headers";

export async function readSession() {
  return (await cookies()).get("session")?.value;
}
`,
    },
    `depends on "next/headers". ${OUTSIDE_APP_MESSAGE}`,
  ],
  [
    "next/headers in a module loaded with a query",
    `"use client";

import { readSession } from "./query-session.ts?probe";

export function ClientGraphProbe() {
  return <p>{typeof readSession}</p>;
}
`,
    {
      "app/client-graph-probe/query-session.ts": `import { cookies } from "next/headers";

export const readSession = cookies;
`,
    },
    `depends on "next/headers" ${CLIENT_COMPONENT_MESSAGE}`,
  ],
  [
    "after() imported by a Client Component",
    `"use client";

import { after } from "next/server";

export function ClientGraphProbe() {
  return <p>{typeof after}</p>;
}
`,
    {},
    `depends on "after" ${CLIENT_COMPONENT_MESSAGE}`,
  ],
];

async function loadCloudflarePlugin(): Promise<Plugin> {
  const { cloudflare } = (await import(
    pathToFileURL(path.join(CF_EXAMPLE_DIR, "node_modules/@cloudflare/vite-plugin/dist/index.mjs"))
      .href
  )) as { cloudflare: (options: unknown) => Plugin };
  // As in the example's vite.config.ts.
  return cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } });
}

async function buildFixture(root: string, plugins: Plugin[] = []): Promise<void> {
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root }), ...plugins],
    resolve: {
      alias: {
        "@test/og-font": path.resolve(import.meta.dirname, "fixtures/og-font-package/lib"),
      },
    },
    logLevel: "silent",
  });
  await builder.buildApp();
}

describe("App Router client builds of the Cloudflare Workers example", () => {
  it.each(PROBES)(
    "reject %s",
    async (_form, clientSource, extraFiles, message) => {
      const root = copyFixture(CF_EXAMPLE_DIR);
      writeProbePage(root, clientSource, extraFiles);

      await expect(buildFixture(root, [await loadCloudflarePlugin()])).rejects.toThrow(message);
    },
    120_000,
  );
});

describe("App Router client builds of the Node fixture", () => {
  it("reject next/headers imported by a Client Component", async () => {
    const [, clientSource, extraFiles, message] = PROBES[0];
    const root = copyFixture(APP_FIXTURE_DIR);
    writeProbePage(root, clientSource, extraFiles);

    await expect(buildFixture(root)).rejects.toThrow(message);
  }, 120_000);
});

describe("App Router client graphs outside the main browser build", () => {
  // The `browser` condition picks a harmless module for the browser build, but
  // SSR evaluates the other one, where the request would be captured.
  const SSR_ONLY_BOUNDARIES: Array<[form: string, clientSource: string]> = [
    [
      "imports",
      `"use client";

import { readSession } from "#client-graph-session";

export function ClientGraphProbe() {
  return <p>{typeof readSession}</p>;
}
`,
    ],
    [
      "only re-exports",
      `"use client";

export { ClientGraphProbe } from "#client-graph-session";
`,
    ],
  ];

  it.each(SSR_ONLY_BOUNDARIES)(
    "reject next/headers that only the SSR graph resolves, from a boundary that %s",
    async (_form, clientSource) => {
      const root = copyFixture(APP_FIXTURE_DIR);
      const packageJsonPath = path.join(root, "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      packageJson.imports = {
        "#client-graph-session": {
          browser: "./lib/client-graph-session-browser.tsx",
          default: "./lib/client-graph-session-server.tsx",
        },
      };
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
      writeProbePage(root, clientSource, {
        "lib/client-graph-session-browser.tsx": `export const readSession = () => undefined;

export function ClientGraphProbe() {
  return <p>browser</p>;
}
`,
        "lib/client-graph-session-server.tsx": `import { cookies } from "next/headers";

export const readSession = cookies;

export function ClientGraphProbe() {
  return <p>{typeof cookies}</p>;
}
`,
      });

      await expect(buildFixture(root)).rejects.toThrow(
        `depends on "next/headers". ${OUTSIDE_APP_MESSAGE}`,
      );
    },
    120_000,
  );

  it("reject next/headers in a Web Worker a Client Component starts", async () => {
    const root = copyFixture(APP_FIXTURE_DIR);
    writeProbePage(
      root,
      `"use client";

export function ClientGraphProbe() {
  return (
    <button
      onClick={() => new Worker(new URL("./probe-worker.ts", import.meta.url), { type: "module" })}
    >
      start
    </button>
  );
}
`,
      {
        "app/client-graph-probe/probe-worker.ts": `import { cookies } from "next/headers";

self.postMessage(typeof cookies);
`,
      },
    );

    await expect(buildFixture(root)).rejects.toThrow(
      `depends on "next/headers" ${CLIENT_COMPONENT_MESSAGE}`,
    );
  }, 120_000);
  it("reject a cache API in a cache module a Web Worker imports", async () => {
    // Worker bundles do not replace "use cache" modules with server
    // references, so the module's own imports would reach the browser.
    const root = copyFixture(APP_FIXTURE_DIR);
    writeProbePage(
      root,
      `"use client";

export function ClientGraphProbe() {
  return (
    <button
      onClick={() => new Worker(new URL("./probe-worker.ts", import.meta.url), { type: "module" })}
    >
      start
    </button>
  );
}
`,
      {
        "app/client-graph-probe/probe-worker.ts": `import { getProbeValue } from "./probe-worker-cache";

void getProbeValue().then((value) => self.postMessage(value));
`,
        "app/client-graph-probe/probe-worker-cache.ts": `"use cache";

import { cacheLife } from "next/cache";

export async function getProbeValue() {
  cacheLife("hours");
  return 1;
}
`,
      },
    );

    await expect(buildFixture(root)).rejects.toThrow(
      `depends on "cacheLife" ${CLIENT_COMPONENT_MESSAGE}`,
    );
  }, 120_000);
  const VIRTUAL_SESSION_MODULES: Array<[form: string, resolvedId: string, source: string]> = [
    [
      "\\0 virtual module",
      "\0virtual:client-graph-session",
      `import { cookies } from "next/headers";

export const readSession = cookies;
`,
    ],
    [
      "unprefixed, extensionless module",
      "virtual:client-graph-session",
      `import { cookies } from "next/headers";

export const readSession = cookies;
`,
    ],
    [
      // The cache transform does not replace virtual modules, so the module's
      // own imports would reach the client graph.
      '\\0 virtual "use cache" module',
      "\0virtual:client-graph-session",
      `"use cache";

import { cookies } from "next/headers";

export async function readSession() {
  return (await cookies()).get("session")?.value;
}
`,
    ],
  ];

  it.each(VIRTUAL_SESSION_MODULES)(
    "reject next/headers in a plugin's %s that a Client Component imports",
    async (_form, resolvedId, source) => {
      const root = copyFixture(APP_FIXTURE_DIR);
      writeProbePage(
        root,
        `"use client";

import { readSession } from "virtual:client-graph-session";

export function ClientGraphProbe() {
  return <p>{typeof readSession}</p>;
}
`,
      );
      const virtualSessionPlugin: Plugin = {
        name: "test:virtual-client-graph-session",
        resolveId(id) {
          return id === "virtual:client-graph-session" ? resolvedId : null;
        },
        load(id) {
          return id === resolvedId ? source : null;
        },
      };

      await expect(buildFixture(root, [virtualSessionPlugin])).rejects.toThrow(
        `depends on "next/headers". ${OUTSIDE_APP_MESSAGE}`,
      );
    },
    120_000,
  );
  // Server reference transforms have already run, so a directive a later
  // plugin adds does not stop the module from reaching the client graph.
  const LATE_DIRECTIVES: Array<[form: string, prologue: string]> = [
    ["a plain module", ""],
    ['a "use cache" module', '"use cache";\n\n'],
    ['a "use server" module', '"use server";\n\n'],
  ];

  it.each(LATE_DIRECTIVES)(
    "reject next/headers in %s that a later app plugin adds under a Client Component",
    async (_form, prologue) => {
      const root = copyFixture(APP_FIXTURE_DIR);
      writeProbePage(
        root,
        `"use client";

import { readSession } from "./probe-session";

export function ClientGraphProbe() {
  return <p>{typeof readSession}</p>;
}
`,
        {
          "app/client-graph-probe/probe-session.ts": `export const readSession = async () => undefined;
`,
        },
      );
      const injectSessionPlugin: Plugin = {
        name: "test:inject-client-graph-session",
        transform(_code, id) {
          if (!id.endsWith("/probe-session.ts")) return null;
          return `${prologue}import { cookies } from "next/headers";

export async function readSession() {
  return (await cookies()).get("session")?.value;
}
`;
        },
      };

      await expect(buildFixture(root, [injectSessionPlugin])).rejects.toThrow(
        `depends on "next/headers" ${CLIENT_COMPONENT_MESSAGE}`,
      );
    },
    120_000,
  );
});

describe("App Router client builds that Next.js accepts", () => {
  it("build Server Function and cache modules that a Client Component imports", async () => {
    // Both are replaced with server reference proxies in the client graph, so
    // their imports never reach the browser; Next.js skips them too.
    const root = copyFixture(APP_FIXTURE_DIR);
    writeProbePage(
      root,
      `"use client";

import { refreshProbe } from "./probe-actions";
import { getCachedProbe } from "./probe-cache";

export function ClientGraphProbe() {
  return <button onClick={() => void refreshProbe().then(() => getCachedProbe())}>probe</button>;
}
`,
      {
        "app/client-graph-probe/probe-actions.ts": `"use server";

import { revalidatePath } from "next/cache";

export async function refreshProbe() {
  revalidatePath("/client-graph-probe");
}
`,
        "app/client-graph-probe/probe-cache.ts": `"use cache";

import { cacheLife } from "next/cache";

export async function getCachedProbe() {
  cacheLife("hours");
  return Date.now();
}
`,
      },
    );

    await expect(buildFixture(root)).resolves.toBeUndefined();
  }, 120_000);
});

describe("App Router dev server", () => {
  it("rejects a Client Component that imports next/headers", async () => {
    const [, clientSource, extraFiles] = PROBES[0];
    const root = copyFixture(APP_FIXTURE_DIR);
    writeProbePage(root, clientSource, extraFiles);

    const server = await createServer({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      server: { host: "127.0.0.1", port: 0 },
      customLogger: createLogger("silent"),
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address !== "object") throw new Error("dev server did not listen");

      // SSR evaluates the Client Component before the browser ever loads it.
      const page = await fetch(`http://127.0.0.1:${address.port}/client-graph-probe`);
      expect(page.status).toBe(500);
      expect(await page.text()).toContain("into a React Client Component module");

      const clientModule = await fetch(
        `http://127.0.0.1:${address.port}/app/client-graph-probe/client-graph-probe.tsx`,
      );
      expect(clientModule.status).toBe(500);
      expect(await clientModule.text()).toContain('depends on \\"next/headers\\" into a React');
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe("findInvalidClientImports", () => {
  it("matches Next.js' client-graph import list", () => {
    const code = [
      `import { cookies } from "next/headers";`,
      `import "next/root-params";`,
      `import { after as later, NextResponse } from "next/server";`,
      `import { revalidatePath, revalidateTag, cacheLife, unstable_cacheLife } from "next/cache";`,
      `import { cacheTag, unstable_cacheTag, unstable_cache, unstable_noStore } from "next/cache";`,
    ].join("\n");

    expect(findInvalidClientImports(code).map((found) => found.name)).toEqual([
      "next/headers",
      "next/root-params",
      "after",
      "revalidatePath",
      "revalidateTag",
      "cacheLife",
      "unstable_cacheLife",
      "cacheTag",
      "unstable_cacheTag",
    ]);
  });

  it("matches escaped specifiers by their decoded value", () => {
    expect(
      findInvalidClientImports(`import { cookies } from "next\\u002fheaders";`).map(
        (found) => found.name,
      ),
    ).toEqual(["next/headers"]);
  });

  it("ignores forms Next.js does not check", () => {
    const code = [
      // Only top-level import declarations count.
      `export { cookies } from "next/headers";`,
      `export * from "next/cache";`,
      `const headers = () => import("next/headers");`,
      `const cache = require("next/cache");`,
      // Library APIs match by imported name, not the local alias.
      `import { NextResponse as after } from "next/server";`,
      `import * as cacheApis from "next/cache";`,
    ].join("\n");

    expect(findInvalidClientImports(code)).toEqual([]);
  });

  it("checks a module whatever its directive", () => {
    // The check runs on final code: a Server Function or cache module that
    // was replaced with server reference proxies no longer has these imports,
    // and one that was not would ship them.
    const imports = `import { cookies } from "next/headers";\nimport { cacheLife } from "next/cache";`;

    for (const directive of ["use client", "use server", "use cache", "use cache: remote"]) {
      expect(
        findInvalidClientImports(`"${directive}";\n${imports}`).map((found) => found.name),
      ).toEqual(["next/headers", "cacheLife"]);
    }
  });

  it("picks Next.js' message by whether the module path starts with app/", () => {
    expect(createInvalidClientImportMessage("next/headers", "/repo/app/c.tsx", "/repo/app")).toBe(
      `You're importing a module that depends on "next/headers" ${CLIENT_COMPONENT_MESSAGE}\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering`,
    );
    expect(createInvalidClientImportMessage("next/headers", "/repo/lib/c.tsx", "/repo/app")).toBe(
      `You're importing a module that depends on "next/headers". ${OUTSIDE_APP_MESSAGE}\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering/server-components`,
    );
  });
});
