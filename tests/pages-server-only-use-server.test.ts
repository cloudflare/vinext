/**
 * A `"use server"` directive must not exempt a module from the `server-only`
 * boundary in a Pages Router client graph. With App Router, @vitejs/plugin-rsc
 * replaces such a module with server reference proxies in the browser build,
 * but Pages-only builds have no such transform, so the module and everything
 * it imports would ship to public client chunks as-is.
 *
 * These builds copy checked-in Pages Router apps (the Cloudflare Workers
 * example and the Node fixture) and add a page that imports a harmless export
 * through a barrel from a `"use server"` module importing `server-only` and a
 * source-held signing key. Next.js 16.2.7 fails the build for this graph with
 * both webpack ("'server-only' cannot be imported from a Client Component
 * module", import trace through the barrel) and Turbopack.
 *
 * The same boundary holds for a page importing from middleware or a Pages API
 * route: those server entries may import `server-only`, but the modules they
 * pull into the page's browser graph may not.
 *
 * Pages-only client graphs are guarded when `server-only` resolves, so the
 * dev server must also reject the module while still serving pages whose
 * stripped data exports import `server-only`, without failing Vite's
 * dependency scan of their untransformed sources.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, createLogger, createServer, type Plugin } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const CF_EXAMPLE_DIR = path.resolve(import.meta.dirname, "../examples/pages-router-cloudflare");
const PAGES_FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/pages-basic");
const WORKSPACE_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const SIGNING_KEY = "__VINEXT_PAGES_USE_SERVER_SIGNING_KEY__";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-use-server-only-"));
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

  writeFile(
    root,
    "server/session-key.ts",
    `export const SESSION_SIGNING_KEY = new TextEncoder().encode(${JSON.stringify(SIGNING_KEY)});\n`,
  );
  writeFile(
    root,
    "server/session-key.cjs",
    `exports.SESSION_SIGNING_KEY = ${JSON.stringify(SIGNING_KEY)};\n`,
  );
  return root;
}

/** A `"use server"` module reached through a barrel that re-exports only `greet`. */
function writeSessionModule(root: string, file: string, source: string) {
  writeFile(root, `server/${file}`, source);
  writeFile(root, "server/index.ts", `export { greet } from "./${file}";\n`);
  writeFile(
    root,
    "pages/use-server-greet.tsx",
    `import { greet } from "../server";

export default function UseServerGreetPage() {
  return <button onClick={() => void greet("visitor")}>greet</button>;
}
`,
  );
}

const ESM_SESSION_BODY = `import { SESSION_SIGNING_KEY } from "./session-key";

export async function greet(name: string) {
  return "hello " + name;
}

export async function signSession(payload: string) {
  return payload + "." + SESSION_SIGNING_KEY.length;
}
`;

const SESSION_MODULES: Array<[form: string, file: string, source: string]> = [
  ["a static import", "session.ts", `"use server";\nimport "server-only";\n${ESM_SESSION_BODY}`],
  [
    "a static import in .mts",
    "session.mts",
    `"use server";\nimport "server-only";\n${ESM_SESSION_BODY}`,
  ],
  [
    "an ES module re-export",
    "session.ts",
    `"use server";\nexport * from "server-only";\n${ESM_SESSION_BODY}`,
  ],
  [
    "a dynamic import",
    "session.ts",
    `"use server";\nvoid import("server-only");\n${ESM_SESSION_BODY}`,
  ],
  [
    "a CommonJS require",
    "session.cjs",
    `"use server";
require("server-only");
const { SESSION_SIGNING_KEY } = require("./session-key.cjs");

exports.greet = async (name) => "hello " + name;
exports.signSession = async (payload) => payload + "." + SESSION_SIGNING_KEY.length;
`,
  ],
];

/**
 * A page importing a harmless constant from a server entry (a Pages API route
 * or middleware) whose own imports reach a `server-only` module. Those server
 * entries may import `server-only`, but the page's browser graph may not:
 * Next.js 16.2.7 fails the client build for both graphs ("You're importing a
 * module that depends on "server-only"", import trace through the server
 * entry) and builds them without the page. Returns the page, the server
 * entry, and the module that imports `server-only`.
 */
const SERVER_ENTRY_CHAINS: Array<
  [
    entry: string,
    write: (
      root: string,
      options: { withPage: boolean },
    ) => { page: string; serverEntry: string; guarded: string },
  ]
> = [
  [
    "a Pages API route",
    (root, { withPage }) => {
      writeFile(
        root,
        "lib/api-secret.ts",
        `import "server-only";\n\nexport const API_SECRET = ${JSON.stringify(SIGNING_KEY)};\n`,
      );
      writeFile(
        root,
        "pages/api/contact-fields.ts",
        `import { API_SECRET } from "../../lib/api-secret";

export const CONTACT_FIELDS = ["name", "email"];

export default function handler(_req: unknown, res: { json(body: unknown): void }) {
  res.json({ keyLength: API_SECRET.length });
}
`,
      );
      if (withPage) {
        writeFile(
          root,
          "pages/contact-fields.tsx",
          `import { CONTACT_FIELDS } from "./api/contact-fields";

export default function ContactFieldsPage() {
  return <p>{CONTACT_FIELDS.join(",")}</p>;
}
`,
        );
      }
      return {
        page: "pages/contact-fields.tsx",
        serverEntry: "pages/api/contact-fields.ts",
        guarded: "lib/api-secret.ts",
      };
    },
  ],
  [
    "middleware",
    (root, { withPage }) => {
      writeFile(
        root,
        "lib/middleware-secret.ts",
        `import "server-only";\n\nexport const MIDDLEWARE_SECRET = ${JSON.stringify(SIGNING_KEY)};\n`,
      );
      fs.appendFileSync(
        path.join(root, "middleware.ts"),
        `
import { MIDDLEWARE_SECRET } from "./lib/middleware-secret";

export const MIDDLEWARE_LABEL = "middleware-" + MIDDLEWARE_SECRET.length;
`,
      );
      if (withPage) {
        writeFile(
          root,
          "pages/middleware-label.tsx",
          `import { MIDDLEWARE_LABEL } from "../middleware";

export default function MiddlewareLabelPage() {
  return <p>{MIDDLEWARE_LABEL}</p>;
}
`,
        );
      }
      return {
        page: "pages/middleware-label.tsx",
        serverEntry: "middleware.ts",
        guarded: "lib/middleware-secret.ts",
      };
    },
  ],
];

async function buildFixture(root: string, plugins: Plugin[] = []): Promise<void> {
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root }), ...plugins],
    logLevel: "silent",
  });
  await builder.buildApp();
}

async function fixturePlugins(useCloudflare: boolean): Promise<Plugin[]> {
  if (!useCloudflare) return [];
  const { cloudflare } = (await import(
    pathToFileURL(path.join(CF_EXAMPLE_DIR, "node_modules/@cloudflare/vite-plugin/dist/index.mjs"))
      .href
  )) as { cloudflare: () => Plugin };
  return [cloudflare()];
}

function serverOnlyClientImportError(importer: string): string {
  return `depends on "server-only". This API is only available in Server Components in the App Router, but ${importer} is reachable from a client bundle.`;
}

describe.each([
  ["Cloudflare Workers example", CF_EXAMPLE_DIR, true],
  ["Node fixture", PAGES_FIXTURE_DIR, false],
])("Pages Router client builds of the %s", (_, fixtureDir, useCloudflare) => {
  it.each(SESSION_MODULES)(
    "reject server-only behind a 'use server' directive through %s",
    async (_form, file, source) => {
      const root = copyFixture(fixtureDir);
      writeSessionModule(root, file, source);

      // The error names the "use server" module as the importer.
      const importer = path.join(fs.realpathSync(root), "server", file);
      await expect(buildFixture(root, await fixturePlugins(useCloudflare))).rejects.toThrow(
        serverOnlyClientImportError(importer),
      );
    },
    120_000,
  );

  it.each(SERVER_ENTRY_CHAINS)(
    "reject server-only reached from a page through %s",
    async (_entry, writeChain) => {
      const root = copyFixture(fixtureDir);
      const { guarded } = writeChain(root, { withPage: true });

      const importer = path.join(fs.realpathSync(root), guarded);
      await expect(buildFixture(root, await fixturePlugins(useCloudflare))).rejects.toThrow(
        serverOnlyClientImportError(importer),
      );
    },
    120_000,
  );

  it.each(SERVER_ENTRY_CHAINS)(
    "build server-only reached only through %s",
    async (_entry, writeChain) => {
      const root = copyFixture(fixtureDir);
      writeChain(root, { withPage: false });

      await expect(
        buildFixture(root, await fixturePlugins(useCloudflare)),
      ).resolves.toBeUndefined();
    },
    120_000,
  );
});

describe("Pages Router dev server", () => {
  it("rejects server-only behind a 'use server' directive and keeps data-export imports working", async () => {
    const root = copyFixture(PAGES_FIXTURE_DIR);
    writeSessionModule(root, "session.ts", SESSION_MODULES[0][2]);
    const chains = SERVER_ENTRY_CHAINS.map(([, writeChain]) =>
      writeChain(root, { withPage: true }),
    );
    writeFile(
      root,
      "lib/gssp-server-only.ts",
      `import "server-only";\n\nexport const GSSP_SECRET = ${JSON.stringify(SIGNING_KEY)};\n`,
    );
    writeFile(
      root,
      "pages/gssp-server-only.tsx",
      `import { GSSP_SECRET } from "../lib/gssp-server-only";

export async function getServerSideProps() {
  return { props: { keyLength: GSSP_SECRET.length } };
}

export default function GsspServerOnlyPage({ keyLength }: { keyLength: number }) {
  return <p data-testid="key-length">{keyLength}</p>;
}
`,
    );

    const errors: string[] = [];
    const logger = createLogger("silent");
    logger.error = (message) => void errors.push(message);
    const server = await createServer({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { host: "127.0.0.1", port: 0 },
      customLogger: logger,
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address !== "object") throw new Error("dev server did not listen");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const html = await (await fetch(`${baseUrl}/gssp-server-only`)).text();
      expect(html).toContain(`data-testid="key-length">${SIGNING_KEY.length}<`);
      const pageModule = await fetch(`${baseUrl}/pages/gssp-server-only.tsx`);
      expect(pageModule.status).toBe(200);
      expect(await pageModule.text()).not.toContain(SIGNING_KEY);

      // The "use server" module itself fails, so the browser never loads its
      // other imports (the signing key).
      const sessionModule = await fetch(`${baseUrl}/server/session.ts`);
      expect(sessionModule.status).toBe(500);
      expect(await sessionModule.text()).toContain('depends on \\"server-only\\"');

      // Middleware already ran (and imported its server-only module) on the
      // server for the request above. The browser graph of a page importing
      // middleware or an API route still fails at the server-only module.
      for (const { page, serverEntry, guarded } of chains) {
        expect((await fetch(`${baseUrl}/${page}`)).status).toBe(200);
        expect((await fetch(`${baseUrl}/${serverEntry}`)).status).toBe(200);
        const guardedModule = await fetch(`${baseUrl}/${guarded}`);
        expect(guardedModule.status).toBe(500);
        expect(await guardedModule.text()).toContain('depends on \\"server-only\\"');
      }

      await server.environments.client.depsOptimizer?.scanProcessing;
      expect(errors.filter((message) => message.includes("dependency scan"))).toEqual([]);
    } finally {
      await server.close();
    }
  }, 120_000);
});
