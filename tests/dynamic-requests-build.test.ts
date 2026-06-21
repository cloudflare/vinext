import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder, createServer } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { _transformVeryDynamicRequests } from "../packages/vinext/src/plugins/ignore-dynamic-requests.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vinext-dynamic-requests-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeFixtureFile(root: string, filePath: string, content: string) {
  const absolutePath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

async function buildApp(root: string) {
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      vinext({
        appDir: root,
        rscOutDir: path.join(root, "dist/server"),
        ssrOutDir: path.join(root, "dist/server/ssr"),
        clientOutDir: path.join(root, "dist/client"),
      }),
    ],
  });
  await builder.buildApp();
}

function writeAppFixture(root: string, options: { dependency?: boolean } = {}) {
  fs.symlinkSync(ROOT_NODE_MODULES, path.join(root, "node_modules"), "junction");
  writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ name: "dynamic-requests", private: true, type: "module" }),
  );
  writeFixtureFile(
    root,
    "app/layout.tsx",
    `import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  writeFixtureFile(
    root,
    "app/page.tsx",
    `${options.dependency ? 'import { runDynamicRequests } from "dynamic-request-dependency";\n\n' : ""}export default function Page() {
  if (Math.random() < 0) dynamic();
  ${options.dependency ? "if (Math.random() < 0) runDynamicRequests();" : ""}
  return <p>Hello World</p>;
}

function dynamic() {
  const request = Math.random() + "";
  require(request);
  import(request);
}
`,
  );
  if (options.dependency) {
    writeFixtureFile(
      root,
      "app/node_modules/dynamic-request-dependency/package.json",
      JSON.stringify({
        name: "dynamic-request-dependency",
        type: "module",
        exports: "./index.js",
      }),
    );
    writeFixtureFile(
      root,
      "app/node_modules/dynamic-request-dependency/index.js",
      `export function runDynamicRequests() {
  const request = Math.random() + "";
  require(request);
  import(request);
}
`,
    );
  }
  writeFixtureFile(
    root,
    "app/hello/route.ts",
    `export function GET() {
  if (Math.random() < 0) dynamic();
  return new Response("Hello World");
}

function dynamic() {
  const request = Math.random() + "";
  require(request);
  import(request);
}
`,
  );
}

describe("App Router dynamic requests", () => {
  it("only rewrites fully dynamic unbound requests", () => {
    const transformed = _transformVeryDynamicRequests(
      `const request = getRequest();
require(request);
import(request);
require("./" + request);
import(\`./\${request}\`);
function local(require) { require(request); }
`,
      "/app/page.tsx",
    )?.code;

    expect(transformed).toContain("Cannot find module as expression is too dynamic");
    expect(transformed).toContain('require("./" + request)');
    expect(transformed).toContain("import(`./${request}`)");
    expect(transformed).toContain("function local(require) { require(request); }");
  });

  it("preserves static literals and partly-static template requests", () => {
    expect(
      _transformVeryDynamicRequests(
        `require("package"); import("./module.js"); import(\`./dir/\${name}.js\`);`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("resolves constant identifier bindings and simple aliases", () => {
    expect(
      _transformVeryDynamicRequests(
        `const request = "./module.js";
const alias = request;
require(request);
import(alias);
`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("rewrites requests without significant static path parts", () => {
    const transformed = _transformVeryDynamicRequests(
      `require("/"); import(\`\${name}\`);`,
      "/app/page.tsx",
    )?.code;
    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(2);
  });

  it("preserves empty strings and conditional static alternatives", () => {
    expect(
      _transformVeryDynamicRequests(
        `require(""); import(unknown ? "./a" : "./b");`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("resolves constant aliases in conditional and nullish predicates", () => {
    const transformed = _transformVeryDynamicRequests(
      `const enabled = true;
const enabledAlias = enabled;
const missing = undefined;
import(enabledAlias ? request : "./fallback");
require(missing ?? request);
`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(2);
  });

  it("matches constant template and unary request patterns", () => {
    const transformed = _transformVeryDynamicRequests(
      "require(`/`); import(void 0); require(!0);",
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(1);
    expect(transformed).toContain("import(void 0)");
    expect(transformed).toContain("require(!0)");
  });

  it("preserves require calls shadowed by loop-header bindings", () => {
    expect(
      _transformVeryDynamicRequests(
        `for (const require of loaders) require(request);
for (let require; condition; ) require(request);
`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("preserves require calls shadowed by switch and named class bindings", () => {
    expect(
      _transformVeryDynamicRequests(
        `switch (value) {
  case 1:
    let require;
    require(request);
}
const Loader = class require {
  load() { require(request); }
};
`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("rewrites fully dynamic requests in dependency modules", () => {
    const transformed = _transformVeryDynamicRequests(
      `export function load(request) { require(request); return import(request); }`,
      "/app/node_modules/dynamic-request-dependency/index.js",
    )?.code;
    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(2);
  });

  it("serves guarded fully dynamic requests in pages and route handlers during development", async () => {
    await withTempDir(async (root) => {
      writeAppFixture(root);
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ appDir: root })],
        server: { port: 0 },
      });

      try {
        await server.listen();
        const baseUrl = server.resolvedUrls?.local[0];
        expect(baseUrl).toBeTruthy();
        if (!baseUrl) return;
        const pageResponse = await fetch(baseUrl);
        const pageBody = await pageResponse.text();
        expect(pageResponse.status, pageBody).toBe(200);
        expect(pageBody).toContain("Hello World");

        const routeResponse = await fetch(new URL("/hello", baseUrl));
        expect(routeResponse.status).toBe(200);
        expect(await routeResponse.text()).toBe("Hello World");
      } finally {
        (server.httpServer as { closeAllConnections?: () => void } | null)?.closeAllConnections?.();
        await server.close();
      }
    });
  });

  // Ported from Next.js: test/e2e/app-dir/dynamic-requests/dynamic-requests.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/dynamic-requests/dynamic-requests.test.ts
  it("builds guarded fully dynamic requests in pages and route handlers", async () => {
    await withTempDir(async (root) => {
      writeAppFixture(root, { dependency: true });
      await expect(buildApp(root)).resolves.not.toThrow();
    });
  });
});
