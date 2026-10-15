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
 * with both webpack and Turbopack, using the messages asserted below. Pages
 * Router pages are client layer too: the Pages builds copy the checked-in
 * Pages apps and import a request API from a page's module graph.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, createLogger, createServer, type Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  createClientGraphServerApisPlugin,
  createInvalidClientImportMessage,
  findInvalidClientImports,
} from "../packages/vinext/src/plugins/client-graph-server-apis.js";

const CF_EXAMPLE_DIR = path.resolve(import.meta.dirname, "../examples/app-router-cloudflare");
const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-basic");
const PAGES_CF_EXAMPLE_DIR = path.resolve(
  import.meta.dirname,
  "../examples/pages-router-cloudflare",
);
const PAGES_FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/pages-basic");
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

// A module that captures the request at module scope.
const SESSION_LIB = `import { cookies } from "next/headers";

export const readSession = cookies;
`;

function prependImport(root: string, file: string, specifier: string) {
  const absPath = path.join(root, file);
  fs.writeFileSync(
    absPath,
    `import ${JSON.stringify(specifier)};\n${fs.readFileSync(absPath, "utf8")}`,
  );
}

function writeDataExportProbePage(root: string, file: string, libSpecifier: string) {
  writeFile(
    root,
    file,
    `import { readSession } from ${JSON.stringify(libSpecifier)};

export async function getServerSideProps() {
  return { props: { session: typeof readSession } };
}

export default function ClientGraphProbe({ session }: { session: string }) {
  return <p>{session}</p>;
}
`,
  );
}

// Next.js 16.2.7 (webpack and Turbopack) checks every module reachable from a
// Pages Router page, in its SSR compile too, with or without app/.
const PAGES_PROBES: Array<[form: string, setup: (root: string) => void]> = [
  [
    "a page component imports",
    (root) => {
      writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
      writeFile(
        root,
        "pages/client-graph-probe.tsx",
        `import { readSession } from "../lib/client-graph-session";

export default function ClientGraphProbe() {
  return <p>{typeof readSession}</p>;
}
`,
      );
    },
  ],
  [
    "only getServerSideProps uses",
    (root) => {
      writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
      writeDataExportProbePage(root, "pages/client-graph-probe.tsx", "../lib/client-graph-session");
    },
  ],
  [
    "only the SSR graph resolves for a page component",
    (root) => {
      const packageJsonPath = path.join(root, "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      packageJson.imports = {
        "#client-graph-session": {
          browser: "./lib/client-graph-session-browser.ts",
          default: "./lib/client-graph-session.ts",
        },
      };
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
      writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
      writeFile(
        root,
        "lib/client-graph-session-browser.ts",
        `export const readSession = () => undefined;
`,
      );
      writeFile(
        root,
        "pages/client-graph-probe.tsx",
        `import { readSession } from "#client-graph-session";

export default function ClientGraphProbe() {
  return <p>{typeof readSession}</p>;
}
`,
      );
    },
  ],
  [
    "pages/_app imports",
    (root) => {
      writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
      prependImport(root, "pages/_app.tsx", "../lib/client-graph-session");
    },
  ],
  [
    "pages/_document imports",
    (root) => {
      writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
      prependImport(root, "pages/_document.tsx", "../lib/client-graph-session");
    },
  ],
];

/**
 * Move the probe page's source out of pages/, leaving a harmless page, and
 * return a resolveId hook that redirects only `entryId`'s import of it.
 */
function redirectProbePageFrom(root: string, entryId: string): Plugin {
  fs.mkdirSync(path.join(root, "page-sources"));
  const replacement = path.join(root, "page-sources/client-graph-probe.tsx");
  fs.renameSync(path.join(root, "pages/client-graph-probe.tsx"), replacement);
  writeFile(
    root,
    "pages/client-graph-probe.tsx",
    `export default function ClientGraphProbe() {
  return null;
}
`,
  );
  return {
    name: "test:redirect-entry-page",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer === entryId && source.endsWith("/pages/client-graph-probe.tsx")) {
        return replacement;
      }
      return null;
    },
  };
}

const PAGES_ROUTER_MESSAGE = `depends on "next/headers". ${OUTSIDE_APP_MESSAGE}`;

describe("Pages Router builds of the Node fixture", () => {
  it.each(PAGES_PROBES)(
    "reject next/headers in a module that %s",
    async (_form, setup) => {
      const root = copyFixture(PAGES_FIXTURE_DIR);
      setup(root);

      await expect(buildFixture(root)).rejects.toThrow(PAGES_ROUTER_MESSAGE);
    },
    120_000,
  );

  it.each([false, true])(
    "reject next/headers that only the SSR graph resolves for a symlinked page (preserveSymlinks: %s)",
    async (preserveSymlinks) => {
      // The page's module id is its real path, outside pages/, unless
      // preserveSymlinks keeps the logical path.
      const root = copyFixture(PAGES_FIXTURE_DIR);
      const [, setupConditionalProbe] = PAGES_PROBES[2];
      setupConditionalProbe(root);
      fs.mkdirSync(path.join(root, "page-sources"));
      fs.renameSync(
        path.join(root, "pages/client-graph-probe.tsx"),
        path.join(root, "page-sources/client-graph-probe.tsx"),
      );
      fs.symlinkSync(
        path.join(root, "page-sources/client-graph-probe.tsx"),
        path.join(root, "pages/client-graph-probe.tsx"),
      );

      if (preserveSymlinks) {
        // The og plugin resolves satori from @vercel/og's module id, which
        // only works on the realpath.
        fs.rmSync(path.join(root, "pages/api/og.tsx"));
        // Logical package paths only resolve dependencies hoisted beside them.
        const hoisted = path.join(WORKSPACE_NODE_MODULES, ".pnpm/node_modules");
        for (const entry of fs.readdirSync(hoisted)) {
          const target = path.join(root, "node_modules", entry);
          if (!fs.existsSync(target)) {
            fs.symlinkSync(path.join(hoisted, entry), target, "junction");
          }
        }
      }
      const preserveSymlinksPlugin: Plugin = {
        name: "test:preserve-symlinks",
        config: () => ({ resolve: { preserveSymlinks } }),
      };
      await expect(buildFixture(root, [preserveSymlinksPlugin])).rejects.toThrow(
        PAGES_ROUTER_MESSAGE,
      );
    },
    120_000,
  );

  it("reject next/headers that only the SSR graph resolves for an aliased page", async () => {
    // The page's module id is the alias replacement, outside pages/.
    const root = copyFixture(PAGES_FIXTURE_DIR);
    const [, setupConditionalProbe] = PAGES_PROBES[2];
    setupConditionalProbe(root);
    fs.mkdirSync(path.join(root, "page-sources"));
    fs.renameSync(
      path.join(root, "pages/client-graph-probe.tsx"),
      path.join(root, "page-sources/client-graph-probe.tsx"),
    );
    writeFile(
      root,
      "pages/client-graph-probe.tsx",
      `export default function ClientGraphProbe() {
  return null;
}
`,
    );
    const pagePath = path.join(root, "pages/client-graph-probe.tsx");
    const replacement = path.join(root, "page-sources/client-graph-probe.tsx");
    const aliasPlugin: Plugin = {
      name: "test:alias-page",
      config: () => ({
        resolve: {
          alias: [pagePath, fs.realpathSync(pagePath)].map((find) => ({ find, replacement })),
        },
      }),
    };

    await expect(buildFixture(root, [aliasPlugin])).rejects.toThrow(PAGES_ROUTER_MESSAGE);
  }, 120_000);

  it("reject next/headers that only the SSR graph resolves for a page redirected from the Pages entry", async () => {
    const root = copyFixture(PAGES_FIXTURE_DIR);
    const [, setupConditionalProbe] = PAGES_PROBES[2];
    setupConditionalProbe(root);
    const redirectPlugin = redirectProbePageFrom(root, "\0virtual:vinext-server-entry");

    await expect(buildFixture(root, [redirectPlugin])).rejects.toThrow(PAGES_ROUTER_MESSAGE);
  }, 120_000);

  // Next.js compiles these in the react-server layer, or without the check.
  const SERVER_LAYER_FILES = [
    "pages/api/client-graph-probe.ts",
    "middleware.ts",
    "instrumentation.ts",
  ];

  it.each(SERVER_LAYER_FILES)(
    "build next/headers in a module that only %s imports",
    async (file) => {
      const root = copyFixture(PAGES_FIXTURE_DIR);
      writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
      if (fs.existsSync(path.join(root, file))) {
        prependImport(root, file, "./lib/client-graph-session");
      } else {
        writeFile(
          root,
          file,
          `import { readSession } from "../../lib/client-graph-session";

export default function handler(_req: unknown, res: { json(body: unknown): void }) {
  res.json({ session: typeof readSession });
}
`,
        );
      }

      await expect(buildFixture(root)).resolves.toBeUndefined();
    },
    120_000,
  );
});

describe("Pages Router builds that Next.js accepts", () => {
  it("build next/headers in a module that an API route imports, when only an entry this build never loads redirects a page to it", async () => {
    const root = copyFixture(PAGES_FIXTURE_DIR);
    writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
    writeFile(
      root,
      "pages/api/client-graph-probe.ts",
      `import { readSession } from "../../lib/client-graph-session";

export default function handler(_req: unknown, res: { json(body: unknown): void }) {
  res.json({ session: typeof readSession });
}
`,
    );
    const session = fs.realpathSync(path.join(root, "lib/client-graph-session.ts"));
    // The Node build loads only the server entry, not the response entry.
    const redirectPlugin: Plugin = {
      name: "test:redirect-inactive-entry-page",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          importer === "\0virtual:vinext-pages-response-entry" &&
          source.endsWith("/pages/index.tsx")
        ) {
          return session;
        }
        return null;
      },
    };

    await expect(buildFixture(root, [redirectPlugin])).resolves.toBeUndefined();
  }, 120_000);

  it('build next/headers in a "use client" module that only an API route imports', async () => {
    // Pages-only apps have no Client Components; Next.js compiles API routes
    // without the check, whatever their modules' directives.
    const root = copyFixture(PAGES_FIXTURE_DIR);
    writeFile(root, "lib/client-graph-session.ts", `"use client";\n\n${SESSION_LIB}`);
    writeFile(
      root,
      "pages/api/client-graph-probe.ts",
      `import { readSession } from "../../lib/client-graph-session";

export default function handler(_req: unknown, res: { json(body: unknown): void }) {
  res.json({ session: typeof readSession });
}
`,
    );

    await expect(buildFixture(root)).resolves.toBeUndefined();
  }, 120_000);

  it.each(["pages/admin/_app/index.tsx", "pages/docs/[...slug]/edit.tsx", "pages/.session.tsx"])(
    "build next/headers in %s, which the Pages Router does not serve, imported only by an API route",
    async (file) => {
      const root = copyFixture(PAGES_FIXTURE_DIR);
      writeFile(root, file, SESSION_LIB);
      const importPath = path.relative(path.join(root, "pages/api"), path.join(root, file));
      writeFile(
        root,
        "pages/api/client-graph-probe.ts",
        `import { readSession } from ${JSON.stringify(importPath.replace(/\.tsx$/, ""))};

export default function handler(_req: unknown, res: { json(body: unknown): void }) {
  res.json({ session: typeof readSession });
}
`,
      );

      await expect(buildFixture(root)).resolves.toBeUndefined();
    },
    120_000,
  );
});

describe("Pages Router directive modules that Next.js skips", () => {
  // Pages-only apps have no RSC transform to replace these modules, and
  // Next.js skips the check for them in every layer.
  it.each([
    ["use server", "resolves"],
    ["use cache", "resolves"],
    ["use cache: remote", "resolves"],
    // Next.js does not recognize these as cache directives.
    ["use cachex", "rejects"],
    ["use cache:remote", "rejects"],
  ] as const)(
    'check next/headers in a "%s" module that a page imports (build %s)',
    async (directive, outcome) => {
      const root = copyFixture(PAGES_FIXTURE_DIR);
      writeFile(
        root,
        "lib/client-graph-session.ts",
        `"${directive}";

import { cookies } from "next/headers";

export async function readSession() {
  return (await cookies()).get("session")?.value;
}
`,
      );
      writeFile(
        root,
        "pages/client-graph-probe.tsx",
        `import { readSession } from "../lib/client-graph-session";

export default function ClientGraphProbe() {
  return <p>{typeof readSession}</p>;
}
`,
      );

      if (outcome === "resolves") {
        await expect(buildFixture(root)).resolves.toBeUndefined();
      } else {
        await expect(buildFixture(root)).rejects.toThrow(PAGES_ROUTER_MESSAGE);
      }
    },
    120_000,
  );
  it.each([
    ["use client", "use server"],
    ["use client", "use cache"],
    // Next.js matches directives by decoded value.
    ["use\\u0020client", "use server"],
  ])(
    'reject next/headers in a "%s" module that also says "%s"',
    async (clientDirective, serverDirective) => {
      // Next.js rejects the directive conflict, so no exemption applies.
      const root = copyFixture(PAGES_FIXTURE_DIR);
      writeFile(
        root,
        "lib/client-graph-session.ts",
        `"${clientDirective}";\n"${serverDirective}";\n\n${SESSION_LIB}`,
      );
      writeFile(
        root,
        "pages/client-graph-probe.tsx",
        `import { readSession } from "../lib/client-graph-session";

export default function ClientGraphProbe() {
  return <p>{typeof readSession}</p>;
}
`,
      );

      await expect(buildFixture(root)).rejects.toThrow(PAGES_ROUTER_MESSAGE);
    },
    120_000,
  );
});

describe("Pages Router builds alongside the App Router", () => {
  it("reject next/headers in a module only getServerSideProps uses", async () => {
    const root = copyFixture(APP_FIXTURE_DIR);
    writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
    writeDataExportProbePage(root, "pages/client-graph-probe.tsx", "../lib/client-graph-session");

    await expect(buildFixture(root)).rejects.toThrow(PAGES_ROUTER_MESSAGE);
  }, 120_000);
});

describe("Pages Router builds of the Cloudflare Workers example", () => {
  it("reject next/headers in a module only getServerSideProps uses", async () => {
    // The Worker environment rendering the pages is not named "ssr".
    const root = copyFixture(PAGES_CF_EXAMPLE_DIR);
    writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
    writeDataExportProbePage(root, "pages/client-graph-probe.tsx", "../lib/client-graph-session");
    const { cloudflare } = (await import(
      pathToFileURL(
        path.join(PAGES_CF_EXAMPLE_DIR, "node_modules/@cloudflare/vite-plugin/dist/index.mjs"),
      ).href
    )) as { cloudflare: (options?: unknown) => Plugin };

    // As in the example's vite.config.ts.
    await expect(buildFixture(root, [cloudflare()])).rejects.toThrow(PAGES_ROUTER_MESSAGE);
  }, 120_000);

  it("reject next/headers that only the SSR graph resolves for a page redirected from the response entry", async () => {
    // The Worker imports pages through the multi-stage response entry.
    const root = copyFixture(PAGES_CF_EXAMPLE_DIR);
    writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
    writeDataExportProbePage(root, "pages/client-graph-probe.tsx", "../lib/client-graph-session");
    const redirectPlugin = redirectProbePageFrom(root, "\0virtual:vinext-pages-response-entry");
    const { cloudflare } = (await import(
      pathToFileURL(
        path.join(PAGES_CF_EXAMPLE_DIR, "node_modules/@cloudflare/vite-plugin/dist/index.mjs"),
      ).href
    )) as { cloudflare: (options?: unknown) => Plugin };

    await expect(buildFixture(root, [redirectPlugin, cloudflare()])).rejects.toThrow(
      PAGES_ROUTER_MESSAGE,
    );
  }, 120_000);
});

describe("Pages Router dev server", () => {
  it("rejects a page whose getServerSideProps uses next/headers", async () => {
    const root = copyFixture(PAGES_FIXTURE_DIR);
    writeFile(root, "lib/client-graph-session.ts", SESSION_LIB);
    writeDataExportProbePage(root, "pages/client-graph-probe.tsx", "../lib/client-graph-session");

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

      const errors: unknown[] = [];
      const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
        errors.push(...args);
      });
      try {
        const page = await fetch(`http://127.0.0.1:${address.port}/client-graph-probe`);
        expect(page.status).toBe(500);
      } finally {
        consoleError.mockRestore();
      }
      // The Pages error page hides the message; the server logs it.
      expect(errors.map(String).join("\n")).toContain("you are using it in the Pages Router");
    } finally {
      await server.close();
    }
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

describe("client-graph dev boundaries", () => {
  it("drops a boundary loaded with a query when its file changes", async () => {
    const plugin = createClientGraphServerApisPlugin({ getAppDir: () => "/repo/app" });
    const boundaryId = "/repo/app/client.tsx?variant";
    const environment = {
      name: "ssr",
      mode: "dev",
      config: { consumer: "server" },
      moduleGraph: {
        getModuleById: (id: string) =>
          id === "/repo/lib/session.ts" ? { importers: [{ id: boundaryId }] } : undefined,
      },
    };
    const error = vi.fn((message: unknown) => {
      throw new Error(String(message));
    });
    const context = { environment, error, resolve: async () => null };
    const transform = plugin.transform as unknown as {
      handler: (this: typeof context, code: string, id: string) => Promise<unknown>;
    };
    const watchChange = plugin.watchChange as unknown as (this: typeof context, id: string) => void;

    await transform.handler.call(
      context,
      `"use client";\nimport { readSession } from "../lib/session";\nexport { readSession };\n`,
      boundaryId,
    );
    // The edit removes the directive, and the boundary's next transform no
    // longer matches the code filter.
    watchChange.call(context, "/repo/app/client.tsx");
    await transform.handler.call(
      context,
      `import { cookies } from "next/headers";\nexport const readSession = cookies;\n`,
      "/repo/lib/session.ts",
    );

    expect(error).not.toHaveBeenCalled();
  });
});

describe("client-graph dev restarts", () => {
  it("does not carry boundaries into a restarted server's environment", async () => {
    const plugin = createClientGraphServerApisPlugin({ getAppDir: () => "/repo/app" });
    const boundaryId = "/repo/app/client.tsx";
    const createEnvironment = () => ({
      name: "ssr",
      mode: "dev",
      config: { consumer: "server" },
      moduleGraph: {
        getModuleById: (id: string) =>
          id === "/repo/lib/session.ts" ? { importers: [{ id: boundaryId }] } : undefined,
      },
    });
    const createContext = (environment: ReturnType<typeof createEnvironment>) => ({
      environment,
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      resolve: async () => null,
    });
    const transform = plugin.transform as unknown as {
      handler: (
        this: ReturnType<typeof createContext>,
        code: string,
        id: string,
      ) => Promise<unknown>;
    };

    await transform.handler.call(
      createContext(createEnvironment()),
      `"use client";\nimport { readSession } from "../lib/session";\nexport { readSession };\n`,
      boundaryId,
    );
    // After server.restart(), a config-dependent transform dropped the
    // directive, so the boundary's new code never reaches this plugin.
    const check = transform.handler.call(
      createContext(createEnvironment()),
      INVALID_HELPER_CODE,
      "/repo/lib/session.ts",
    );

    await expect(check).resolves.toBeNull();
  });
});

describe("client-graph server environments", () => {
  it.each([
    ["ssr", true],
    // An auxiliary Worker renders no Client Components.
    ["aux_worker", false],
  ])(
    'treats a "use client" module in the %s environment as a client root: %s',
    async (name, rejects) => {
      const plugin = createClientGraphServerApisPlugin({ getAppDir: () => "/repo/app" });
      const boundaryId = "/repo/worker/client.ts";
      const environment = {
        name,
        mode: "dev",
        config: { consumer: "server" },
        moduleGraph: {
          getModuleById: (id: string) =>
            id === "/repo/lib/session.ts" ? { importers: [{ id: boundaryId }] } : undefined,
        },
      };
      const context = {
        environment,
        error: (message: unknown) => {
          throw new Error(String(message));
        },
        resolve: async () => null,
      };
      const transform = plugin.transform as unknown as {
        handler: (this: typeof context, code: string, id: string) => Promise<unknown>;
      };

      await transform.handler.call(
        context,
        `"use client";\nimport { readSession } from "../lib/session";\nexport { readSession };\n`,
        boundaryId,
      );
      const check = transform.handler.call(
        context,
        `import { cookies } from "next/headers";\nexport const readSession = cookies;\n`,
        "/repo/lib/session.ts",
      );

      if (rejects) await expect(check).rejects.toThrow('depends on "next/headers"');
      else await expect(check).resolves.toBeNull();
    },
  );
});

describe("client-graph Pages roots", () => {
  it("are not built for an environment that loaded no Pages entry", async () => {
    // An auxiliary Worker that imports a Pages route file for shared code.
    const pagePath = "/repo/pages/shared.tsx";
    const plugin = createClientGraphServerApisPlugin({
      getAppDir: () => null,
      getPagesPages: async () => new Set([pagePath]),
      pagesEntryIds: ["\0virtual:vinext-server-entry"],
    });
    const context = createBuildContext("aux_worker", {
      "/repo/worker/index.ts": { importers: [] },
      [pagePath]: { code: INVALID_HELPER_CODE, importers: ["/repo/worker/index.ts"] },
    });

    await expect(callBuildEnd(plugin, context)).resolves.toBeUndefined();
  });

  it.each([
    ["ssr", true],
    // An auxiliary Worker that imports a Pages route file for shared code.
    ["aux_worker", false],
  ])(
    "in dev include directly loaded pages only in the Pages environment (%s rejects: %s)",
    async (name, rejects) => {
      const pagePath = "/repo/pages/shared.tsx";
      const plugin = createClientGraphServerApisPlugin({
        getAppDir: () => null,
        getPagesPages: async () => new Set([pagePath]),
        pagesEntryIds: ["\0virtual:vinext-server-entry"],
        isPagesDevEnvironment: (environment) => (environment as { name: string }).name === "ssr",
      });
      const context = {
        environment: {
          name,
          mode: "dev",
          config: { consumer: "server" },
          moduleGraph: {
            getModuleById: (id: string) =>
              id === "/repo/lib/session.ts" ? { importers: [{ id: pagePath }] } : undefined,
          },
        },
        error: (message: unknown) => {
          throw new Error(String(message));
        },
        resolve: async (source: string) => ({ id: source }),
      };
      const transform = plugin.transform as unknown as {
        handler: (this: typeof context, code: string, id: string) => Promise<unknown>;
      };

      const check = transform.handler.call(
        context,
        `import { cookies } from "next/headers";\nexport const readSession = cookies;\n`,
        "/repo/lib/session.ts",
      );

      if (rejects) await expect(check).rejects.toThrow(PAGES_ROUTER_MESSAGE);
      else await expect(check).resolves.toBeNull();
    },
  );

  it("skip buildEnd in dev, where perEnvironmentStartEndDuringDev runs it", async () => {
    const plugin = createClientGraphServerApisPlugin({ getAppDir: () => null });
    const context = {
      ...createBuildContext("ssr", { "/repo/lib/session.ts": { importers: [] } }),
      environment: { name: "ssr", mode: "dev", config: { consumer: "server" } },
      getModuleInfo: () => {
        throw new Error("getModuleInfo().code is not supported in dev");
      },
    };

    await expect(callBuildEnd(plugin, context)).resolves.toBeUndefined();
  });

  it("check each build's final module code, whatever a watch rebuild reused", async () => {
    const pagePath = "/repo/pages/index.tsx";
    const entryId = "\0virtual:vinext-server-entry";
    const helperId = "\0virtual:session";
    const plugin = createClientGraphServerApisPlugin({
      getAppDir: () => null,
      getPagesPages: async () => new Set([pagePath]),
      pagesEntryIds: [entryId],
    });
    const build = (helperCode: string, helperImporters: string[]) =>
      callBuildEnd(
        plugin,
        createBuildContext("ssr", {
          [entryId]: { importers: [] },
          [pagePath]: { importers: [entryId] },
          [helperId]: { code: helperCode, importers: helperImporters },
        }),
      );

    // Only an API route imports the helper.
    await expect(
      build(INVALID_HELPER_CODE, ["/repo/pages/api/session.ts"]),
    ).resolves.toBeUndefined();
    // A rebuild where the page imports it, though its transform was cached.
    await expect(build(INVALID_HELPER_CODE, [pagePath])).rejects.toThrow(PAGES_ROUTER_MESSAGE);
    // A rebuild where the regenerated module no longer imports next/headers.
    await expect(
      build("export const readSession = () => null;\n", [pagePath]),
    ).resolves.toBeUndefined();
  });
});

const INVALID_HELPER_CODE = `import { cookies } from "next/headers";\nexport const readSession = cookies;\n`;

/** A build-mode plugin context over a fixed module graph. */
function createBuildContext(
  environmentName: string,
  modules: Record<string, { code?: string; importers: string[] }>,
) {
  return {
    environment: { name: environmentName, mode: "build", config: { consumer: "server" } },
    error: (error: string | { message: string }) => {
      throw new Error(typeof error === "string" ? error : error.message);
    },
    resolve: async (source: string) => ({ id: source }),
    getModuleIds: () => Object.keys(modules)[Symbol.iterator](),
    getModuleInfo: (id: string) => {
      const module = modules[id];
      return module
        ? { code: module.code ?? "", importers: module.importers, dynamicImporters: [] }
        : null;
    },
  };
}

function callBuildEnd(plugin: Plugin, context: object) {
  return (plugin.buildEnd as unknown as (this: object) => Promise<void>).call(context);
}

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
    // Without app/, every module gets the Pages Router message.
    expect(createInvalidClientImportMessage("next/headers", "/repo/app/c.tsx", null)).toContain(
      OUTSIDE_APP_MESSAGE,
    );
  });
});
