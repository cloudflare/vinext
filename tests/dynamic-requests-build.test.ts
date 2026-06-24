import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createBuilder, createServer } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  _transformVeryDynamicRequests,
  createIgnoreDynamicRequestsPlugin,
} from "../packages/vinext/src/plugins/ignore-dynamic-requests.js";

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
  require/* comment-separated call */(request);
  import/* comment-separated call */(request);
  require(/* webpackIgnore: false */ request);
  import(/* turbopackIgnore: false */ request);
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
  require/* comment-separated call */(request);
  import/* comment-separated call */(request);
  require(/* turbopackIgnore: false */ request);
  import(/* webpackIgnore: false */ request);
}
`,
  );
}

describe("App Router dynamic requests", () => {
  it("matches Next.js environment scoping", () => {
    const transform = createIgnoreDynamicRequestsPlugin(() => [
      "transpiled",
      "@scope/pkg",
    ]).transform;
    if (!transform || typeof transform === "function") {
      throw new Error("dynamic request transform hook not found");
    }
    const runTransform = (consumer: "client" | "server", id: string) =>
      transform.handler.call(
        { environment: { config: { consumer } } } as never,
        "import(request)",
        id,
      );

    expect(runTransform("server", "/app/page.tsx")).toBeTruthy();
    expect(runTransform("client", "/app/page.tsx")).toBeNull();
    expect(
      runTransform("client", "/app/node_modules/dynamic-request-dependency/index.js"),
    ).toBeTruthy();
    expect(runTransform("client", "/app/node_modules/transpiled/index.js")).toBeNull();
    expect(runTransform("client", "/app/node_modules/@scope/pkg/index.js")).toBeNull();
    expect(
      runTransform(
        "client",
        "/app/node_modules/.pnpm/transpiled@1.0.0/node_modules/transpiled/index.js",
      ),
    ).toBeNull();
    expect(
      runTransform(
        "client",
        "/app/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/index.js",
      ),
    ).toBeNull();
    expect(runTransform("client", String.raw`C:\app\node_modules\transpiled\index.js`)).toBeNull();
    expect(runTransform("client", "/app/node_modules/transpiled-extra/index.js")).toBeTruthy();
    expect(runTransform("client", "/app/node_modules/@scope/pkg-extra/index.js")).toBeTruthy();
    expect(runTransform("server", "/app/node_modules/transpiled/index.js")).toBeTruthy();
  });

  it("only rewrites fully dynamic unbound requests", () => {
    expect(
      _transformVeryDynamicRequests("export const value = getValue();", "/app/page.tsx"),
    ).toBeNull();

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

  it("bounds constant alias resolution", () => {
    const aliases = ['const request0 = "./module.js";'];
    for (let index = 1; index < 2_000; index++) {
      aliases.push(`const request${index} = request${index - 1};`);
    }
    aliases.push("import(request1999);");

    const transformed = _transformVeryDynamicRequests(aliases.join("\n"), "/app/page.tsx")?.code;
    expect(transformed).toContain("Cannot find module as expression is too dynamic");
  });

  it("resolves long constant alias chains below the linker budget", () => {
    const aliases = ['const request0 = "./module.js";'];
    for (let index = 1; index < 1_499; index++) {
      aliases.push(`const request${index} = request${index - 1};`);
    }
    aliases.push("import(request1498);");

    expect(_transformVeryDynamicRequests(aliases.join("\n"), "/app/page.tsx")).toBeNull();
  });

  it("resolves constant aliases in their declaration scope", () => {
    expect(
      _transformVeryDynamicRequests(
        `const prefix = "./";
const request = prefix + "module.js";
{
  const prefix = getPrefix();
  import(request);
}
`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("tracks shadowed constant bindings by identity", () => {
    expect(
      _transformVeryDynamicRequests(
        `const prefix = "./";
const request = prefix + "module.js";
{
  const prefix = request;
  import(prefix);
}
`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("resolves constant bindings in template interpolations", () => {
    expect(
      _transformVeryDynamicRequests(
        `const part = "module";
const alias = part;
require(\`${"${part}"}\`);
import(\`${"${alias}"}\`);
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

  it("matches Turbopack constants for unshadowed numeric globals", () => {
    const transformed = _transformVeryDynamicRequests(
      `const notANumber = NaN;
const infinity = Infinity;
import(NaN);
require(infinity);
import(\`./module-\${notANumber}\`);
require(NaN ? "./fallback" : request);
import(Infinity ? request : "./fallback");
require(NaN && request);
import(NaN || request);
function shadowed(NaN, Infinity) {
  require(NaN);
  import(Infinity);
}`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(4);
    expect(transformed).toContain("import(NaN)");
    expect(transformed).toContain("require(infinity)");
    expect(transformed).toContain("import(`./module-${notANumber}`)");
    expect(transformed).toContain('require(NaN ? "./fallback" : request)');
    expect(transformed).toContain("import(NaN || request)");
    expect(transformed).not.toContain("require(NaN && request)");
  });

  it("resolves constant bindings that shadow global constants", () => {
    expect(
      _transformVeryDynamicRequests(
        `const undefined = "./undefined";
const NaN = "./nan";
const Infinity = "./infinity";
require(undefined);
import(NaN);
require(Infinity);`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("resolves constant string predicates", () => {
    const transformed = _transformVeryDynamicRequests(
      `const zero = 0;
const empty = "";
import(\`\` ? "./fallback" : request);
require(\`enabled\` ? request : "./fallback");
import(\`\${""}\` ? "./fallback" : request);
require(\`prefix-\${request}\` ? request : "./fallback");
import(\`\${zero}\` ? request : "./fallback");
require(\`\${empty}\` ? "./fallback" : request);
import(String.raw\`\` ? "./fallback" : request);
require(String.raw\`enabled\` ? request : "./fallback");
import(("" + "") ? "./fallback" : request);
require(("enabled" + "") ? request : "./fallback");`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(10);
  });

  it("matches constant template and unary request patterns", () => {
    const transformed = _transformVeryDynamicRequests(
      `require(\`/\`);
import(void 0);
require(void /pattern/);
import(void -1);
require(void value);
import(!0);
require(!value);
import(-1);
require(-0);
import(-1n);
require(+1);`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(6);
    expect(transformed).toContain("import(void 0)");
    expect(transformed).toContain("require(void /pattern/)");
    expect(transformed).toContain("import(!0)");
    expect(transformed).toContain("import(-1)");
    expect(transformed).toContain("require(-0)");
  });

  it("does not evaluate side effects in void request expressions", () => {
    const transformed = _transformVeryDynamicRequests(
      `let calls = 0;
function sideEffect() { calls += 1; }
try { require(void sideEffect()); } catch {}
`,
      "/app/page.tsx",
    )?.code;

    expect(transformed).toContain("Cannot find module as expression is too dynamic");
    expect(vm.runInNewContext(`${transformed}; calls`)).toBe(0);
  });

  it("resolves constant expressions in template interpolations", () => {
    expect(
      _transformVeryDynamicRequests("require(`${42}`); import(`${!0}`);", "/app/page.tsx"),
    ).toBeNull();
  });

  it("preserves bounded String.raw templates", () => {
    expect(
      _transformVeryDynamicRequests(
        String.raw`require(String.raw\`./dir/\${request}.js\`); import(String.raw\`\x2f\${request}\`);`,
        "/app/page.tsx",
      ),
    ).toBeNull();

    const transformed = _transformVeryDynamicRequests(
      "require(String.raw`${request}`); import(String.raw`/${request}`); import(String['raw']`./dir/${request}.js`);",
      "/app/page.tsx",
    )?.code;
    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(3);
  });

  it("treats side-effecting sequence requests as fully dynamic", () => {
    const transformed = _transformVeryDynamicRequests(
      `require((0, "./module.js"));
import((sideEffect(), "./module.js"));`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(1);
    expect(transformed).toContain('require((0, "./module.js"))');
    expect(transformed).not.toContain("sideEffect()");
  });

  it("matches Turbopack side-effect analysis for sequence prefixes", () => {
    expect(
      _transformVeryDynamicRequests(
        `require((String.raw\`./dir/\${request}\`, "./module.js"));
import((import.meta.url, "./module.js"));
require(({ value: request }, "./module.js"));
import(({ ...source }, "./module.js"));`,
        "/app/page.tsx",
      ),
    ).toBeNull();

    const transformed = _transformVeryDynamicRequests(
      `require(({ get value() { return request; } }, "./module.js"));
import(({ method() { return request; } }, "./module.js"));
require((tag\`./dir/\${request}\`, "./module.js"));`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(3);
    expect(transformed).not.toContain("get value");
    expect(transformed).not.toContain("method()");
    expect(transformed).not.toContain("tag`");
  });

  it("preserves dynamic requests with statically bounded string concatenation", () => {
    expect(
      _transformVeryDynamicRequests(
        `const prefix = "./dir/";
const concat = "concat";
const templateConcat = \`concat\`;
const addedConcat = "con" + "cat";
const conditionalConcat = condition ? "concat" : \`concat\`;
require("./dir/".concat(request));
import("./dir/".concat(request, ".js"));
require(prefix.concat(request));
import(prefix["concat"](request));
require(prefix[concat](request));
import(prefix[templateConcat](request));
require(prefix[addedConcat](request));
import(prefix[conditionalConcat](request));
import("".concat(request).concat(".js"));
require((condition ? "./a/" : "./b/").concat(request));
`,
        "/app/page.tsx",
      ),
    ).toBeNull();

    const transformed = _transformVeryDynamicRequests(
      `require("".concat(request)); import("/".concat(request));`,
      "/app/page.tsx",
    )?.code;
    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(1);
    expect(transformed).toContain('require("".concat(request))');
  });

  it("does not treat numeric addition as a statically bounded request", () => {
    const transformed = _transformVeryDynamicRequests(
      `const number = 1;
const prefix = "./dir/";
require(number + request);
import(1 + request);
require((condition ? "./dir/" : 1) + request);
require(prefix + request);
import((condition ? "./a/" : "./b/") + request);
import(1 + prefix + request);
`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(3);
    expect(transformed).toContain("require(prefix + request)");
    expect(transformed).toContain('import((condition ? "./a/" : "./b/") + request)');
    expect(transformed).toContain("import(1 + prefix + request)");
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

  it("resolves constant initializers in loop headers", () => {
    expect(
      _transformVeryDynamicRequests(
        `for (const request = "./module"; condition; ) require(request);
`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("rewrites comment-separated dynamic request calls", () => {
    const transformed = _transformVeryDynamicRequests(
      `require/* comment */(request); import/* comment */(request);`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(2);
  });

  it("preserves explicit dynamic request ignore comments", () => {
    const transformed = _transformVeryDynamicRequests(
      `const request = getRequest();
require(/* webpackIgnore: true */ request);
import(/* turbopackIgnore: true */ request);
require(/* webpackIgnore: false */ request);
import(/* turbopackIgnore: false */ request);
require(/* unrelated: true */ request);
require(${"/* unrelated */".repeat(10_000)} /* webpackIgnore: true */ request);
`,
      "/app/page.tsx",
    )?.code;

    expect(transformed).toContain("require(/* webpackIgnore: true */ request)");
    expect(transformed).toContain("import(/* turbopackIgnore: true */ request)");
    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(3);
  });

  it("preserves Vite-ignored dynamic imports", () => {
    const transformed = _transformVeryDynamicRequests(
      `const request = getRequest();
import(/* @vite-ignore */ request);
require(/* @vite-ignore */ request);
`,
      "/app/page.tsx",
    )?.code;

    expect(transformed).toContain("import(/* @vite-ignore */ request)");
    expect(transformed).not.toContain("require(/* @vite-ignore */ request)");
    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(1);
  });

  it("honors the last explicit dynamic request ignore value at runtime", () => {
    const transformed = _transformVeryDynamicRequests(
      `const request = getRequest();
const loaded = [];
loaded.push(require(/* webpackIgnore: false */ /* turbopackIgnore: true */ request));
try { require(/* turbopackIgnore: true */ /* webpackIgnore: false */ request); } catch (error) {
  loaded.push(error.message);
}
`,
      "/app/page.tsx",
    )?.code;

    expect(transformed).toBeTruthy();
    expect(
      vm.runInNewContext(`${transformed}; loaded`, {
        getRequest: () => "ignored-module",
        require: (request: string) => request,
      }),
    ).toEqual(["ignored-module", "Cannot find module as expression is too dynamic"]);
  });

  it("preserves require calls shadowed by switch, class, and static block bindings", () => {
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
class StaticLoader {
  static {
    const require = load;
    require(request);
  }
}
`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });

  it("keeps switch-case bindings out of the discriminant scope", () => {
    const transformed = _transformVeryDynamicRequests(
      `switch (require(request)) {
  case require(request):
    let require;
    require(request);
}`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(1);
    expect(transformed?.match(/require\(request\)/g)).toHaveLength(2);
  });

  it("tracks TypeScript value bindings without treating type-only imports as values", () => {
    const transformed = _transformVeryDynamicRequests(
      `import type { require as TypeOnlyRequire } from "types";
import { type require } from "types";
require(request);
{
  enum require { Value }
  require(request);
}
{
  namespace require {}
  require(request);
}
{
  import require = require("module");
  require(request);
}`,
      "/app/page.ts",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(1);
    expect(transformed).toContain("enum require { Value }\n  require(request)");
    expect(transformed).toContain("namespace require {}\n  require(request)");
    expect(transformed).toContain('import require = require("module");\n  require(request)');
  });

  it("preserves require calls shadowed by TypeScript parameter properties", () => {
    expect(
      _transformVeryDynamicRequests(
        `class Loader {
  constructor(private require: (request: string) => unknown) {
    require(request);
  }
}`,
        "/app/page.ts",
      ),
    ).toBeNull();
  });

  it("preserves require calls shadowed inside TypeScript namespaces", () => {
    const transformed = _transformVeryDynamicRequests(
      `namespace Loader {
  const require = load;
  require(request);
}
module Resolver {
  if (condition) var require = load;
  require(request);
}
require(request);
`,
      "/app/page.ts",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(1);
    expect(transformed?.match(/require\(request\)/g)).toHaveLength(2);
  });

  it("contains var bindings within class static blocks", () => {
    const transformed = _transformVeryDynamicRequests(
      `class StaticLoader {
  static {
    if (condition) {
      var require = load;
    }
    require(request);
  }
}
require(request);
`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(1);
    expect(transformed).toContain("require(request);");
  });

  it("excludes function body bindings from default parameter initializers", () => {
    const transformed = _transformVeryDynamicRequests(
      `function withConst(value = require(request)) {
  const require = load;
  return require(value);
}
function withVar(value = require(request)) {
  var require = load;
  return require(value);
}
function withDeclaration(value = require(request)) {
  function require(value) { return value; }
  return require(value);
}
`,
      "/app/page.tsx",
    )?.code;

    expect(transformed?.match(/Cannot find module as expression is too dynamic/g)).toHaveLength(3);
    expect(transformed?.match(/return require\(value\);/g)).toHaveLength(3);
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
