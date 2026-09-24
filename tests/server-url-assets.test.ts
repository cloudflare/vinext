/**
 * Unit tests for `vinext:server-url-assets` and its runtime registry.
 *
 * Next.js serves `fetch(new URL(<file>, import.meta.url))` from edge code by
 * emitting the file as an edge asset and short-circuiting fetch
 * (packages/next/src/server/web/sandbox/fetch-inline-assets.ts). The
 * end-to-end behaviour is covered against the pages-basic fixture in
 * tests/pages-router.test.ts; these tests pin the transform, the generated
 * modules and the fetch interception directly.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toSlash } from "pathslash";
import type { Plugin } from "vite-plus";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  collectClientReferenceOnlyModules,
  createServerUrlAssetsPlugin,
  jsStringLiteral,
  resolveServerUrlAssetFile,
} from "../packages/vinext/src/plugins/server-url-assets.js";
import {
  decodeServerUrlAsset,
  fetchServerUrlAsset,
  registerServerUrlAsset,
} from "../packages/vinext/src/server/server-url-assets.js";

type Hook = (...args: unknown[]) => unknown;

function unwrapHook(hook: unknown): Hook {
  if (typeof hook === "function") return hook as Hook;
  if (hook && typeof hook === "object" && "handler" in hook) {
    return (hook as { handler: Hook }).handler;
  }
  throw new Error("Cannot unwrap hook");
}

function findPlugin(): Plugin {
  const plugin = (vinext() as Plugin[]).find((p) => p.name === "vinext:server-url-assets");
  if (!plugin) throw new Error("vinext:server-url-assets plugin not found");
  return plugin;
}

const REGISTRATION_PREFIX = "\0vinext-server-url-asset:";
const BYTES_PREFIX = "\0vinext-server-url-asset-bytes:";

let root: string;
let importer: string;
let textFile: string;
let imageFile: string;
let parenFile: string;
let workerFile: string;
let tsPayloadFile: string;
let packagedJson: string;
const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0x0a, 0x0d]);

beforeAll(async () => {
  // Real path so Node's resolver (which follows symlinks) agrees with the
  // URL-relative paths on macOS, where os.tmpdir() is behind /var -> /private/var.
  root = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-server-url-assets-")));
  await fsp.mkdir(path.join(root, "pages/api"), { recursive: true });
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  // Unpackaged directory, as in the Next.js fixture: Vite's resolver needs a
  // package.json, so this exercises the Node resolver fallback.
  await fsp.mkdir(path.join(root, "node_modules/my-pkg/hello"), { recursive: true });
  importer = path.join(root, "pages/api/edge.js");
  textFile = path.join(root, "src/text-file.txt");
  imageFile = path.join(root, "src/vercel.png");
  parenFile = path.join(root, "src/text (1).txt");
  packagedJson = path.join(root, "node_modules/my-pkg/hello/world.json");
  await fsp.writeFile(importer, "");
  await fsp.writeFile(textFile, "Hello, from text-file.txt!\n");
  await fsp.writeFile(imageFile, imageBytes);
  await fsp.writeFile(parenFile, "parenthesised");
  await fsp.writeFile(packagedJson, '{ "i am": "a node dependency" }');
  workerFile = path.join(root, "pages/api/worker.js");
  tsPayloadFile = path.join(root, "src/payload.ts");
  await fsp.writeFile(workerFile, "export {};");
  await fsp.writeFile(tsPayloadFile, 'export const payload: string = "ts";\n');
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function transform(
  code: string,
  resolve: (specifier: string) => Promise<{ id: string; external?: boolean } | null> = async () =>
    null,
  environmentName = "rsc",
): Promise<string | null> {
  const plugin = findPlugin();
  const result = (await unwrapHook(plugin.transform).call(
    { environment: { name: environmentName }, resolve: (specifier: string) => resolve(specifier) },
    code,
    importer,
  )) as { code: string } | null;
  return result?.code ?? null;
}

function transformCodeFilter(): RegExp {
  return (findPlugin().transform as { filter: { code: RegExp } }).filter.code;
}

// Valid `new URL(<file>, import.meta.url)` references whose source text puts
// comments, newlines, `)` or escapes between the tokens. The transform's native code
// filter must not reject them, or they stay unregistered and fail on Workers.
const TRIVIA_REFERENCE_SOURCES = [
  `export const url = new URL("../../src/text-file.txt", import /* comment */.meta.url);`,
  `export const url = new URL("../../src/text-file.txt", import. /* a */ meta /* b */ . /* c */ url);`,
  `export const url = new URL("../../src/text-file.txt" /* ) */, import.meta.url);`,
  `export const url = new URL(/* see (notes) */ "../../src/text-file.txt", import.meta.url);`,
  [
    "export const url = new URL(",
    "  // falls back to the bundled copy :)",
    `  "../../src/text-file.txt",`,
    "  import // trailing line comment",
    "    .meta",
    "    .url,",
    ");",
  ].join("\n"),
  // Unicode-escaped property names are still `url` to the parser.
  String.raw`export const url = new URL("../../src/text-file.txt", import.meta.\u0075rl);`,
];

function registrationImport(binding: string, assetPath: string): string {
  return `import ${binding} from ${jsStringLiteral(`${REGISTRATION_PREFIX}${toSlash(assetPath)}.js`)};`;
}

describe("vinext:server-url-assets transform", () => {
  it("only applies to server environments", () => {
    const plugin = findPlugin();
    const applies = plugin.applyToEnvironment as (environment: unknown) => boolean;
    expect(applies({ name: "rsc", config: { consumer: "server" } })).toBe(true);
    expect(applies({ name: "ssr", config: { consumer: "server" } })).toBe(true);
    expect(applies({ name: "client", config: { consumer: "client" } })).toBe(false);
    // Nitro re-bundles the built vinext server outputs, whose remaining
    // `new URL` references point at emitted files next to those outputs.
    expect(applies({ name: "nitro", config: { consumer: "server" } })).toBe(false);
  });

  it("pre-filters modules on any import.meta.url read, tolerating JavaScript trivia", () => {
    const filter = transformCodeFilter();

    for (const source of TRIVIA_REFERENCE_SOURCES) {
      expect(filter.test(source), source).toBe(true);
    }
    expect(filter.test(`fetch(new URL("./text-file.txt", import.meta.url));`)).toBe(true);
    expect(filter.test(`new URL(\n  "./text-file.txt",\n  import.meta.url,\n);`)).toBe(true);

    // No import.meta.url read, so no module can hold a rewritable reference.
    expect(filter.test(`new URL("./text-file.txt", base);`)).toBe(false);
    expect(filter.test(`new URL(request.url); const meta = { url: "" };`)).toBe(false);
  });

  it("rewrites references hidden by comments, newlines and parentheses once pre-filtered", async () => {
    const filter = transformCodeFilter();

    for (const source of TRIVIA_REFERENCE_SOURCES) {
      // Mirrors Vite: the handler only runs when the native filter matches.
      const code = filter.test(source) ? await transform(source) : null;
      expect(code, source).toContain(registrationImport("__vinext_server_url_asset0", textFile));
      expect(code, source).toContain("new URL(__vinext_server_url_asset0)");
      expect(code, source).not.toContain("import.meta");
    }

    // `)` inside the specifier does not hide the reference either.
    const parenSource = `fetch(new URL("../../src/text (1).txt", import.meta.url));`;
    expect(filter.test(parenSource)).toBe(true);
    expect(await transform(parenSource)).toContain(
      registrationImport("__vinext_server_url_asset0", parenFile),
    );
  });

  it("skips the ssr environment only for App Router builds without pages/", () => {
    const environments = [
      { name: "rsc", config: { consumer: "server" } },
      { name: "ssr", config: { consumer: "server" } },
      // Cloudflare Pages Router builds name the server environment after the Worker.
      { name: "my_worker", config: { consumer: "server" } },
    ];
    const appliesTo = (isAppRouterOnly: boolean) => {
      const plugin = createServerUrlAssetsPlugin({ isAppRouterOnly: () => isAppRouterOnly });
      const applies = plugin.applyToEnvironment as (environment: unknown) => boolean;
      return environments.filter((environment) => applies(environment)).map(({ name }) => name);
    };

    expect(appliesTo(true)).toEqual(["rsc", "my_worker"]);
    expect(appliesTo(false)).toEqual(["rsc", "ssr", "my_worker"]);
  });

  it("skips use client modules in the RSC environment, which only holds client references", async () => {
    const reference = `export const url = new URL("../../src/text-file.txt", import.meta.url);`;
    expect(await transform(`"use client";\n${reference}`)).toBeNull();
    expect(await transform(`"use strict";\n'use client';\n${reference}`)).toBeNull();
    // Only the directive prologue counts, as in React.
    expect(await transform(`${reference}\n"use client";`)).toContain(
      registrationImport("__vinext_server_url_asset0", textFile),
    );
  });

  it("rewrites use client modules in other server environments, where the Pages Router runs them", async () => {
    // Without a plugin-rsc scan (dev, Pages-only builds) the directive alone
    // cannot say whether the Pages Router runs the module on the server.
    const reference = `export const url = new URL("../../src/text-file.txt", import.meta.url);`;
    for (const environmentName of ["ssr", "my_worker"]) {
      expect(
        await transform(`"use client";\n${reference}`, undefined, environmentName),
        environmentName,
      ).toContain(registrationImport("__vinext_server_url_asset0", textFile));
    }
  });

  // Ported from Next.js: test/e2e/edge-compiler-can-import-blob-assets/app/pages/api/edge.js
  // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-compiler-can-import-blob-assets/app/pages/api/edge.js
  it("rewrites relative and node_modules asset references to registered URLs", async () => {
    const code = await transform(
      [
        `const text = () => fetch(new URL("../../src/text-file.txt", import.meta.url));`,
        `const image = () => fetch(new URL('../../src/vercel.png', import.meta.url));`,
        "const json = () => fetch(new URL(`my-pkg/hello/world.json`, import.meta.url));",
        `const remote = () => fetch(new URL("https://example.vercel.sh"));`,
        `const remoteWithBase = () => fetch(new URL("/", "https://example.vercel.sh"));`,
      ].join("\n"),
    );

    expect(code).toContain(registrationImport("__vinext_server_url_asset0", textFile));
    expect(code).toContain(registrationImport("__vinext_server_url_asset1", imageFile));
    expect(code).toContain(registrationImport("__vinext_server_url_asset2", packagedJson));
    expect(code).toContain("fetch(new URL(__vinext_server_url_asset0))");
    expect(code).toContain("fetch(new URL(__vinext_server_url_asset1))");
    expect(code).toContain("fetch(new URL(__vinext_server_url_asset2))");
    expect(code).toContain(`fetch(new URL("https://example.vercel.sh"))`);
    expect(code).toContain(`fetch(new URL("/", "https://example.vercel.sh"))`);
    expect(code).not.toContain("import.meta.url");
  });

  it("uses Vite's resolver for module requests before falling back to Node's", async () => {
    const resolve = vi.fn(async (specifier: string) =>
      specifier === "@assets/text-file.txt" ? { id: `${textFile}?v=1` } : null,
    );
    const code = await transform(
      `export const url = new URL("@assets/text-file.txt", import.meta.url);`,
      resolve,
    );

    expect(resolve).toHaveBeenCalledWith("@assets/text-file.txt");
    expect(code).toContain(registrationImport("__vinext_server_url_asset0", textFile));
  });

  it("falls back to Node resolution when Vite marks the module request external", async () => {
    const code = await transform(
      `export const url = new URL("my-pkg/hello/world.json", import.meta.url);`,
      async (specifier) => ({ id: specifier, external: true }),
    );

    expect(code).toContain(registrationImport("__vinext_server_url_asset0", packagedJson));
  });

  it("imports each asset once and keeps directives first", async () => {
    const code = await transform(
      [
        `"use server";`,
        `export const a = new URL("../../src/text-file.txt", import.meta.url);`,
        `export const b = new URL("../../src/text-file.txt", import.meta.url);`,
      ].join("\n"),
    );

    expect(code?.startsWith(`"use server";\n`)).toBe(true);
    expect(code?.match(/import __vinext_server_url_asset0 /g)).toHaveLength(1);
    expect(code).not.toContain("__vinext_server_url_asset1");
    expect(code?.match(/new URL\(__vinext_server_url_asset0\)/g)).toHaveLength(2);
  });

  it("picks a binding prefix that does not collide with module code", async () => {
    const code = await transform(
      [
        `const __vinext_server_url_asset0 = "user";`,
        `export const url = new URL("../../src/text-file.txt", import.meta.url);`,
      ].join("\n"),
    );

    expect(code).toContain(registrationImport("__vinext_server_url_asset_0", textFile));
    expect(code).toContain("new URL(__vinext_server_url_asset_0)");
  });

  it("leaves references it cannot turn into a file asset untouched", async () => {
    const source = [
      // Missing file: stays a runtime URL, like Vite's client handling.
      `const missing = new URL("./missing.txt", import.meta.url);`,
      // Worker scripts load code, not bytes.
      `const worker = new Worker(new URL("./worker.js", import.meta.url));`,
      // Runtime-computed specifiers cannot be resolved at build time.
      "const dynamic = new URL(`../../src/${name}.txt`, import.meta.url);",
      // Absolute URLs and paths keep URL semantics.
      `const file = new URL("file:///etc/hosts", import.meta.url);`,
      `const absolute = new URL("/src/text-file.txt", import.meta.url);`,
      `const query = new URL("../../src/text-file.txt?raw", import.meta.url);`,
      // Explicit opt-out, same as Vite.
      `const ignored = new URL(/* @vite-ignore */ "../../src/text-file.txt", import.meta.url);`,
      // Not import.meta.url-relative.
      `const other = new URL("../../src/text-file.txt", base);`,
    ].join("\n");

    expect(await transform(source)).toBeNull();
  });

  it("leaves URLs that load code as runtime URLs", async () => {
    const codeLoads = [
      `new Worker(new URL("./worker.js", import.meta.url));`,
      `new Worker(new URL("./worker.js", import.meta.url), { type: "module" });`,
      `new SharedWorker(new URL("./worker.js", import.meta.url));`,
      // Any static spelling of the constructor.
      `new worker_threads.Worker(new URL("./worker.js", import.meta.url));`,
      `new worker_threads["Worker"](new URL("./worker.js", import.meta.url));`,
      `new globalThis["Worker"](new URL("./worker.js", import.meta.url));`,
      "new globalThis[`SharedWorker`](new URL(`./worker.js`, import.meta.url));",
      `new (Worker)(new URL("./worker.js", import.meta.url));`,
      `new (globalThis.Worker)(new URL("./worker.js", import.meta.url));`,
      `Reflect.construct(Worker, [new URL("./worker.js", import.meta.url), { type: "module" }]);`,
      `Reflect["construct"](globalThis["SharedWorker"], [new URL("./worker.js", import.meta.url)]);`,
      // Any expression built from the URL is still the code-loading operand.
      `new Worker(new URL("./worker.js", import.meta.url).href);`,
      `new Worker((new URL("./worker.js", import.meta.url)).toString());`,
      `new Worker(new URL("./worker.js", import.meta.url)["href"]);`,
      `new Worker(String(new URL("./worker.js", import.meta.url)));`,
      `await import(new URL("./worker.js", import.meta.url));`,
      `await import(new URL("./worker.js", import.meta.url).href);`,
      `await import(new URL("./worker.js", import.meta.url)["href"]);`,
      "await import(new URL(`./worker.js`, import.meta.url)[`href`]);",
      'await import(`${new URL("./worker.js", import.meta.url)}`);',
      `await import(dev ? new URL("./worker.js", import.meta.url) : new URL("../../src/payload.ts", import.meta.url));`,
      // Whatever the extension: the dynamic import decides, not the file.
      `await import(new URL("../../src/text-file.txt", import.meta.url).href);`,
    ];
    // A sibling fetch of the same file is still read as bytes, which also
    // proves each module parsed and was transformed.
    const bytesFetch = `export const bytes = () => fetch(new URL("./worker.js", import.meta.url));`;
    for (const codeLoad of codeLoads) {
      const code = await transform(`${codeLoad}\n${bytesFetch}`);
      expect(code, codeLoad).toContain(codeLoad);
      expect(code, codeLoad).toContain("fetch(new URL(__vinext_server_url_asset0))");
      expect(code, codeLoad).toContain(
        registrationImport("__vinext_server_url_asset0", workerFile),
      );
      expect(code, codeLoad).not.toContain("__vinext_server_url_asset1");
    }
  });

  // Next.js applies its edge asset loader to every `new URL(<file>,
  // import.meta.url)` dependency whatever the extension:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack-config.ts
  it("rewrites script files that are read as bytes", async () => {
    const code = await transform(
      [
        `export const js = () => fetch(new URL("./worker.js", import.meta.url));`,
        `export const ts = () => fetch(new URL("../../src/payload.ts", import.meta.url));`,
      ].join("\n"),
    );

    expect(code).toContain(registrationImport("__vinext_server_url_asset0", workerFile));
    expect(code).toContain(registrationImport("__vinext_server_url_asset1", tsPayloadFile));
    expect(code).not.toContain("import.meta.url");
  });

  it("skips modules without a parseable absolute id", async () => {
    const plugin = findPlugin();
    const result = await unwrapHook(plugin.transform).call(
      { environment: { name: "rsc" }, resolve: async () => null },
      `new URL("./text-file.txt", import.meta.url)`,
      "virtual-module.js",
    );
    expect(result).toBeNull();
  });
});

describe("jsStringLiteral", () => {
  it("escapes characters that could break out of generated code, keeping the value", () => {
    const value = "file:///app/</script>\u2028\u2029\0\"'`.txt";
    const literal = jsStringLiteral(value);

    expect(literal).not.toMatch(/[<>/\u2028\u2029]/);
    expect(literal).toContain(String.raw`\u003c\u002fscript\u003e\u2028\u2029`);
    expect(JSON.parse(literal)).toBe(value);
  });
});

describe("collectClientReferenceOnlyModules", () => {
  it("keeps modules the Pages Router reaches and collects the client-reference-only closure", () => {
    // A hybrid App + Pages `ssr` graph: the Pages Router and plugin-rsc's
    // client-reference branch share one environment.
    const clientReferences = "\0virtual:vite-rsc/client-references";
    const clientReferenceGroup = `${clientReferences}/group/app`;
    const graph: Record<string, { imports?: string[]; dynamic?: string[]; entry?: boolean }> = {
      "ssr-entry": { entry: true, imports: ["pages-entry", clientReferences] },
      "pages-entry": { dynamic: ["pages/api/edge.ts", "pages/widget.tsx"] },
      "pages/api/edge.ts": { imports: ["lib/shared.ts"] },
      // A Pages page importing a "use client" component that App Router
      // pages also use: the Pages Router runs it (and its imports) on the server.
      "pages/widget.tsx": { imports: ["components/widget.tsx"] },
      [clientReferences]: { dynamic: [clientReferenceGroup, "components/widget.tsx"] },
      [clientReferenceGroup]: { imports: ["app/button.tsx", "app/panel.tsx"] },
      // App Router-only client references, and a cycle back into one of them.
      "app/button.tsx": { imports: ["app/button-helper.ts", "lib/shared.ts"] },
      "app/panel.tsx": { imports: ["app/panel-helper.ts"] },
      "app/button-helper.ts": { imports: ["app/button.tsx"] },
      "app/panel-helper.ts": {},
      "components/widget.tsx": { imports: ["components/widget-helper.ts"] },
      "components/widget-helper.ts": {},
      "lib/shared.ts": {},
    };

    const clientOnly = collectClientReferenceOnlyModules({
      moduleIds: Object.keys(graph),
      getModuleInfo: (id) => {
        const node = graph[id];
        return node
          ? {
              isEntry: node.entry === true,
              importedIds: node.imports ?? [],
              dynamicallyImportedIds: node.dynamic ?? [],
            }
          : null;
      },
      isClientReferenceBranch: (id) => id.startsWith(clientReferences),
    });

    expect([...clientOnly].sort()).toEqual([
      clientReferences,
      clientReferenceGroup,
      "app/button-helper.ts",
      "app/button.tsx",
      "app/panel-helper.ts",
      "app/panel.tsx",
    ]);
  });
});

describe("resolveServerUrlAssetFile", () => {
  it("prefers the URL-relative file and never module-resolves explicit relative paths", async () => {
    const resolveModule = vi.fn(async () => packagedJson);

    await expect(
      resolveServerUrlAssetFile("../../src/text-file.txt", importer, resolveModule),
    ).resolves.toBe(toSlash(textFile));
    await expect(
      resolveServerUrlAssetFile("./missing.json", importer, resolveModule),
    ).resolves.toBeNull();
    expect(resolveModule).not.toHaveBeenCalled();

    await expect(
      resolveServerUrlAssetFile("my-pkg/hello/world.json", importer, resolveModule),
    ).resolves.toBe(packagedJson);
    expect(resolveModule).toHaveBeenCalledWith("my-pkg/hello/world.json", importer);
  });

  it("accepts module resolutions to any file, but not directories", async () => {
    await expect(
      resolveServerUrlAssetFile("my-pkg", importer, async () => workerFile),
    ).resolves.toBe(workerFile);
    await expect(
      resolveServerUrlAssetFile("my-pkg", importer, async () => path.join(root, "src")),
    ).resolves.toBeNull();
  });
});

describe("vinext:server-url-assets generated modules", () => {
  function load(id: string) {
    const plugin = findPlugin();
    const watched: string[] = [];
    const context = {
      addWatchFile: (file: string) => watched.push(file),
      error: (message: string): never => {
        throw new Error(message);
      },
    };
    return {
      watched,
      result: unwrapHook(plugin.load).call(context, id) as Promise<string>,
    };
  }

  it("resolves only its own ids", () => {
    const plugin = findPlugin();
    const hook = plugin.resolveId as { filter: { id: RegExp }; handler: Hook };
    const id = `${REGISTRATION_PREFIX}${toSlash(textFile)}.js`;
    expect(hook.filter.id.test(id)).toBe(true);
    expect(hook.filter.id.test(`${BYTES_PREFIX}${toSlash(textFile)}.js`)).toBe(true);
    // Without the `.js` suffix, Vite's builtin JSON/CSS plugins would claim the id.
    expect(hook.filter.id.test(`${REGISTRATION_PREFIX}${toSlash(packagedJson)}`)).toBe(false);
    expect(hook.handler(id)).toBe(id);
  });

  it("registers the asset's file URL with a lazy bytes loader", async () => {
    const assetPath = toSlash(textFile);
    const { result, watched } = load(`${REGISTRATION_PREFIX}${assetPath}.js`);
    const code = await result;

    expect(code).toContain(
      `registerServerUrlAsset(${jsStringLiteral(pathToFileURL(textFile).href)}, () => import(${jsStringLiteral(`${BYTES_PREFIX}${assetPath}.js`)}))`,
    );
    expect(code).toMatch(
      /import \{ registerServerUrlAsset \} from ".*server-url-assets\.(?:ts|js)";/,
    );
    expect(watched).toEqual([]);
  });

  it("inlines the asset bytes and watches the file", async () => {
    const assetPath = toSlash(imageFile);
    const { result, watched } = load(`${BYTES_PREFIX}${assetPath}.js`);
    const code = await result;
    const base64 = code.match(/decodeServerUrlAsset\("([^"]*)"\)/)?.[1];

    expect(base64).toBeDefined();
    expect(Buffer.from(decodeServerUrlAsset(base64!)).equals(imageBytes)).toBe(true);
    expect(watched).toEqual([assetPath]);
  });

  it("reports unreadable assets", async () => {
    const { result } = load(`${BYTES_PREFIX}${toSlash(path.join(root, "gone.txt"))}.js`);
    await expect(result).rejects.toThrow(/Could not read server asset/);
  });
});

describe("server URL asset runtime", () => {
  const STATE_KEY = Symbol.for("vinext.serverUrlAssets");
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    delete globals[STATE_KEY];
    globalThis.fetch = realFetch;
  });

  function loader(bytes: Uint8Array) {
    return vi.fn(async () => ({ default: bytes }));
  }

  it("decodes base64 with and without Uint8Array.fromBase64", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    const base64 = Buffer.from(all).toString("base64");
    expect(decodeServerUrlAsset(base64)).toEqual(all);

    const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    Object.defineProperty(Uint8Array, "fromBase64", { value: undefined, configurable: true });
    try {
      expect(decodeServerUrlAsset(base64)).toEqual(all);
    } finally {
      if (descriptor) Object.defineProperty(Uint8Array, "fromBase64", descriptor);
      else delete (Uint8Array as unknown as Record<string, unknown>).fromBase64;
    }
  });

  it("serves registered hrefs for string and URL inputs only", async () => {
    const href = registerServerUrlAsset("file:///app/src/text-file.txt", loader(imageBytes));
    expect(href).toBe("file:///app/src/text-file.txt");

    const fromUrl = await fetchServerUrlAsset(new URL(href));
    expect(fromUrl?.status).toBe(200);
    expect(fromUrl?.headers.get("content-type")).toBeNull();
    expect(Buffer.from(await fromUrl!.arrayBuffer()).equals(imageBytes)).toBe(true);

    const fromString = await fetchServerUrlAsset(href);
    expect(Buffer.from(await fromString!.arrayBuffer()).equals(imageBytes)).toBe(true);

    expect(fetchServerUrlAsset("file:///app/src/other.txt")).toBeUndefined();
    // Next.js matches `String(input)`, so Request objects are not assets.
    expect(fetchServerUrlAsset(new Request("https://example.com/"))).toBeUndefined();
  });

  it("does not let one response corrupt the bytes served to the next", async () => {
    const href = registerServerUrlAsset("file:///app/src/vercel.png", loader(imageBytes.slice()));

    const first = new Uint8Array(await (await fetchServerUrlAsset(href))!.arrayBuffer());
    first.fill(0);
    const second = Buffer.from(await (await fetchServerUrlAsset(href))!.arrayBuffer());
    expect(second.equals(imageBytes)).toBe(true);
  });

  it("wraps the global fetch once and delegates everything else", async () => {
    const platformFetch = vi.fn(async () => new Response("network"));
    globalThis.fetch = platformFetch as typeof fetch;

    const load = loader(new TextEncoder().encode("asset"));
    const href = registerServerUrlAsset("file:///app/src/text-file.txt", load);
    registerServerUrlAsset("file:///app/src/other.txt", loader(new Uint8Array()));
    const wrappedFetch = globalThis.fetch;
    expect(wrappedFetch).not.toBe(platformFetch);

    // Module-scope fetches (e.g. fonts in OG routes) run before any
    // request-time fetch patch, so the registration wrapper must serve them.
    expect(await (await fetch(new URL(href))).text()).toBe("asset");
    expect(load).toHaveBeenCalledTimes(1);
    expect(platformFetch).not.toHaveBeenCalled();

    const init = { method: "POST" };
    expect(await (await fetch("https://example.com/", init)).text()).toBe("network");
    expect(platformFetch).toHaveBeenCalledWith("https://example.com/", init);

    registerServerUrlAsset("file:///app/src/third.txt", loader(new Uint8Array()));
    expect(globalThis.fetch).toBe(wrappedFetch);
  });
});
