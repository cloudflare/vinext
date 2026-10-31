import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite-plus";
import { nitroTracedExternals } from "../packages/vinext/src/build/nitro-trace-deps.js";
import vinext from "../packages/vinext/src/index.js";

const tempDirs: string[] = [];

type NitroSetupTarget = {
  options: {
    dev?: boolean;
    preset?: string;
    baseURL?: string;
    serveStatic?: boolean | string;
    plugins?: string[];
    virtual?: Record<string, string | (() => string)>;
    output?: { publicDir?: string };
    routeRules?: Record<string, Record<string, unknown>>;
    traceDeps?: (string | RegExp)[];
  };
  hooks?: {
    hook(name: "build:before", handler: () => void): unknown;
    afterEach(callback: (event: { name: string }) => void): () => void;
  };
};

type NitroSetupPlugin = {
  nitro?: {
    setup?: (nitro: NitroSetupTarget) => Promise<void> | void;
  };
} & Plugin;

// Runs vinext's Nitro module the way Nitro does: every module's `setup` first
// (`otherModules` stands in for modules installed after vinext), then the
// `build:before` handlers followed by hookable's `afterEach` callbacks, right
// before Nitro reads its options to bundle.
async function runNitroSetup(
  nitroPlugin: NitroSetupPlugin,
  nitro: NitroSetupTarget,
  otherModules?: (nitro: NitroSetupTarget) => void,
): Promise<{ callBuildBefore: () => void }> {
  const buildBefore: (() => void)[] = [];
  const afterEach: ((event: { name: string }) => void)[] = [];
  nitro.hooks = {
    hook: (_name, handler) => buildBefore.push(handler),
    afterEach: (callback) => {
      afterEach.push(callback);
      return () => {};
    },
  };
  await nitroPlugin.nitro!.setup!(nitro);
  otherModules?.(nitro);
  // Nitro calls other hooks before `build:before`; vinext only merges on it.
  const beforeOtherHook = nitro.options.traceDeps;
  for (const callback of afterEach) callback({ name: "rollup:reload" });
  expect(nitro.options.traceDeps).toBe(beforeOtherHook);
  // Nitro's Vite builder calls `build:before` once; its other builders call
  // it for each build.
  const callBuildBefore = () => {
    for (const handler of buildBefore) handler();
    for (const callback of afterEach) callback({ name: "build:before" });
  };
  callBuildBefore();
  return { callBuildBefore };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function isPlugin(plugin: unknown): plugin is Plugin {
  return !!plugin && !Array.isArray(plugin) && typeof plugin === "object" && "name" in plugin;
}

function findNamedPlugin(plugins: ReturnType<typeof vinext>, name: string) {
  return plugins.find((plugin): plugin is Plugin => isPlugin(plugin) && plugin.name === name);
}

function makeTempProject(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-project", private: true }, null, 2),
  );
  return root;
}

function writeProjectFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// Whether these `traceDeps` make Nitro's externals plugin treat a resolved
// module as a traced external (Nitro's builtin native package list is not
// modelled), mirroring how `resolveTraceDeps` builds its include pattern:
// string names are escaped (a `name*` full-trace entry contributes `name`), a
// `!name` string removes that name, and RegExp entries contribute their source.
// https://github.com/nitrojs/nitro/blob/main/src/build/plugins/externals.ts
function isTracedByNitro(traceDeps: readonly (string | RegExp)[], resolvedId: string): boolean {
  const negated = new Set(
    traceDeps
      .filter((dep): dep is string => typeof dep === "string" && dep.startsWith("!"))
      .map((dep) => dep.slice(1)),
  );
  const sources = traceDeps
    .filter((dep) => typeof dep !== "string" || !dep.startsWith("!"))
    .map((dep) => (typeof dep === "string" ? dep.replace(/\*$/, "") : dep))
    .filter((dep) => typeof dep !== "string" || !negated.has(dep))
    .map((dep) =>
      typeof dep === "string" ? dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : dep.source,
    );
  if (sources.length === 0) return false;
  return new RegExp(`(?:^|[/\\\\]node_modules[/\\\\])(?:${sources.join("|")})(?:[/\\\\]|$)`).test(
    resolvedId,
  );
}

function createAppProject(): string {
  const root = makeTempProject("vinext-nitro-app-");
  writeProjectFile(
    root,
    "app/layout.tsx",
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  writeProjectFile(
    root,
    "app/page.tsx",
    "export default function Home() { return <div>home</div>; }\n",
  );
  writeProjectFile(
    root,
    "app/blog/[slug]/page.tsx",
    [
      'import { cookies } from "next/headers";',
      "export const revalidate = 60;",
      "export default async function BlogPage() {",
      '  const session = (await cookies()).get("session")?.value;',
      "  return <div>blog for {session}</div>;",
      "}",
      "",
    ].join("\n"),
  );
  writeProjectFile(
    root,
    "app/isr/page.tsx",
    [
      "export const revalidate = 3600;",
      "export default function IsrPage() {",
      "  return <div>{new Date().toISOString()}</div>;",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

function createPagesProject(): string {
  const root = makeTempProject("vinext-nitro-pages-");
  writeProjectFile(
    root,
    "pages/index.tsx",
    "export default function Home() { return <div>home</div>; }\n",
  );
  writeProjectFile(
    root,
    "pages/blog/[slug].tsx",
    [
      "export async function getStaticProps() {",
      "  return { props: {}, revalidate: 45 };",
      "}",
      "",
      "export default function BlogPage() {",
      "  return <div>blog</div>;",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

async function initializeNitroSetupPlugin(root: string): Promise<NitroSetupPlugin> {
  const plugins = vinext({ appDir: root, rsc: false }) as ReturnType<typeof vinext>;
  const configPlugin = findNamedPlugin(plugins, "vinext:config") as Plugin & {
    config?: (
      config: { root: string; plugins: unknown[] },
      env: { command: "build"; mode: string },
    ) => Promise<unknown>;
  };
  if (!configPlugin?.config) {
    throw new Error("vinext:config plugin not found");
  }

  // Passing empty plugins array means hasNitroPlugin=false in the closure,
  // but the nitro.setup hook doesn't gate on hasNitroPlugin (Nitro calls it directly).
  await configPlugin.config({ root, plugins: [] }, { command: "build", mode: "production" });

  const nitroPlugin = findNamedPlugin(plugins, "vinext:nitro-setup") as NitroSetupPlugin;
  if (!nitroPlugin?.nitro?.setup) {
    throw new Error("vinext:nitro-setup plugin not found");
  }

  return nitroPlugin;
}

describe("vinext Nitro setup integration", () => {
  // Nitro copies every string `traceDeps` entry into `.output/server/node_modules`
  // whether the server imports it or not (nitrojs/nitro#4391), which shipped
  // every installed default external (`typescript`, `webpack`, `playwright`,
  // ...) in every build. Next.js only ships the externals the server imports.
  it("propagates server externals to Nitro traceDeps without force-copying them", async () => {
    const root = createAppProject();
    writeProjectFile(
      root,
      "next.config.mjs",
      `export default { serverExternalPackages: ["custom-apm", "@scope/traced", "socket.io"] };\n`,
    );
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro: NitroSetupTarget = {
      options: {
        dev: false,
        routeRules: {},
        traceDeps: ["existing-trace", "pg*"],
      },
    };

    await runNitroSetup(nitroPlugin, nitro);

    const traceDeps = nitro.options.traceDeps ?? [];
    // Only the user's own `traceDeps` are force-copied.
    expect(traceDeps.filter((dep) => typeof dep === "string")).toEqual(["existing-trace", "pg*"]);

    // Server externals are still traced when the server imports them.
    for (const name of [
      "mongodb",
      "typescript",
      "webpack",
      "custom-apm",
      "@scope/traced",
      "socket.io",
    ]) {
      expect(isTracedByNitro(traceDeps, `/app/node_modules/${name}/index.js`)).toBe(true);
    }
    expect(isTracedByNitro(traceDeps, "/app/node_modules/webpack-sources/index.js")).toBe(false);
    expect(isTracedByNitro(traceDeps, "/app/node_modules/xmongodb/index.js")).toBe(false);
    expect(isTracedByNitro(traceDeps, "/app/node_modules/socketxio/index.js")).toBe(false);
    // A scoped default external is matched exactly too.
    expect(isTracedByNitro(traceDeps, "/app/node_modules/@prisma/client/index.js")).toBe(true);
    expect(isTracedByNitro(traceDeps, "/app/node_modules/@prisma/client-extra/index.js")).toBe(
      false,
    );

    // Nitro 3.0.260311-beta and earlier join the entries into one pattern.
    const joined = traceDeps.join("|");
    const legacyInclude = new RegExp(
      `^(?:${joined})|[/\\\\]node_modules[/\\\\](?:${joined})(?:[/\\\\])`,
    );
    expect(legacyInclude.test("/app/node_modules/socket.io/index.js")).toBe(true);
    expect(legacyInclude.test("/app/node_modules/@prisma/client/index.js")).toBe(true);
    expect(legacyInclude.test("/app/node_modules/socketxio/index.js")).toBe(false);

    const patterns = traceDeps.filter((dep) => dep instanceof RegExp).map((dep) => dep.source);
    expect(new Set(patterns).size).toBe(patterns.length);
    // `pg` is already a user entry.
    expect(patterns.filter((source) => new RegExp(`^(?:${source})$`).test("pg"))).toEqual([]);
  });

  it("keeps a user traceDeps opt-out for a server external", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro: NitroSetupTarget = {
      options: { dev: false, routeRules: {}, traceDeps: ["!pg"] },
    };

    await runNitroSetup(nitroPlugin, nitro);

    const traceDeps = nitro.options.traceDeps ?? [];
    expect(isTracedByNitro(traceDeps, "/app/node_modules/pg/lib/index.js")).toBe(false);
    expect(isTracedByNitro(traceDeps, "/app/node_modules/mongodb/lib/index.js")).toBe(true);
  });

  it("keeps a traceDeps opt-out added by a Nitro module set up after vinext", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro: NitroSetupTarget = { options: { dev: false, routeRules: {} } };

    await runNitroSetup(nitroPlugin, nitro, (later) => {
      (later.options.traceDeps ??= []).push("!mongodb");
    });

    const traceDeps = nitro.options.traceDeps ?? [];
    expect(isTracedByNitro(traceDeps, "/app/node_modules/mongodb/lib/index.js")).toBe(false);
    expect(isTracedByNitro(traceDeps, "/app/node_modules/pg/lib/index.js")).toBe(true);
  });

  it("keeps a traceDeps opt-out a later Nitro module adds in build:before", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro: NitroSetupTarget = { options: { dev: false, routeRules: {} } };

    await runNitroSetup(nitroPlugin, nitro, (later) => {
      later.hooks!.hook("build:before", () => {
        (later.options.traceDeps ??= []).push("!mongodb");
      });
    });

    const traceDeps = nitro.options.traceDeps ?? [];
    expect(isTracedByNitro(traceDeps, "/app/node_modules/mongodb/lib/index.js")).toBe(false);
    expect(isTracedByNitro(traceDeps, "/app/node_modules/pg/lib/index.js")).toBe(true);
  });

  it("does not add server externals twice when Nitro calls build:before again", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro: NitroSetupTarget = {
      options: { dev: false, routeRules: {}, traceDeps: [/mongodb/] },
    };

    const { callBuildBefore } = await runNitroSetup(nitroPlugin, nitro);
    const once = (nitro.options.traceDeps ?? []).map(String);
    callBuildBefore();

    expect((nitro.options.traceDeps ?? []).map(String)).toEqual(once);
    // The user's own RegExp for a server external isn't duplicated either.
    expect(once.filter((dep) => dep === "/mongodb/")).toHaveLength(1);
  });

  it("keeps a traceDeps opt-out added before Nitro calls build:before again", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro: NitroSetupTarget = { options: { dev: false, routeRules: {} } };

    const { callBuildBefore } = await runNitroSetup(nitroPlugin, nitro);
    nitro.options.traceDeps!.push("!mongodb");
    callBuildBefore();

    const traceDeps = nitro.options.traceDeps ?? [];
    expect(isTracedByNitro(traceDeps, "/app/node_modules/mongodb/lib/index.js")).toBe(false);
    expect(isTracedByNitro(traceDeps, "/app/node_modules/pg/lib/index.js")).toBe(true);
  });

  // Nitro reads `!` before `*`, so `!pg*` negates the literal selector `pg*`.
  it("still traces a server external whose name only appears in a `!name*` selector", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro: NitroSetupTarget = {
      options: { dev: false, routeRules: {}, traceDeps: ["!pg*"] },
    };

    await runNitroSetup(nitroPlugin, nitro);

    expect(
      isTracedByNitro(nitro.options.traceDeps ?? [], "/app/node_modules/pg/lib/index.js"),
    ).toBe(true);
  });

  // A path-keyed Nitro response cache cannot see request-time dynamic usage,
  // so a `revalidate` page that reads cookies() would be replayed to other
  // users, and it would bypass vinext's on-demand revalidation even for static
  // ISR pages. vinext's own ISR cache serves both instead.
  it("does not add Nitro cache rules for App Router revalidate routes", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = {
      options: {
        dev: false,
        routeRules: {
          "/blog/*": { headers: { "x-test": "1" } },
        },
      },
    };

    await runNitroSetup(nitroPlugin, nitro);

    expect(nitro.options.routeRules).toEqual({
      "/blog/*": { headers: { "x-test": "1" } },
    });
  });

  it("does not add Nitro cache rules for Pages Router getStaticProps revalidate routes", async () => {
    const root = createPagesProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = { options: { dev: false, routeRules: {} } };

    await runNitroSetup(nitroPlugin, nitro);

    expect(nitro.options.routeRules).toEqual({});
  });

  // vinext serves the public files its router resolves, such as a rewrite
  // destination, through Nitro's static handler.
  it("registers the public files plugin when Nitro's server serves static files", async () => {
    const root = createPagesProject();
    writeProjectFile(root, "public/a%20b.txt", "file\n");
    writeProjectFile(root, "public/%2Fsecret.txt", "file\n");
    writeProjectFile(root, "public/data.json", "{}\n");
    writeProjectFile(root, "public/uncopied.txt", "file\n");
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro: NitroSetupTarget = {
      options: {
        dev: false,
        preset: "node-server",
        baseURL: "/",
        serveStatic: true,
        output: { publicDir: path.join(root, ".output/public") },
      },
    };

    await runNitroSetup(nitroPlugin, nitro);
    await runNitroSetup(nitroPlugin, nitro);
    // Nitro copies the public files, and `compressPublicAssets` writes its
    // compressed copies, after setup and before it bundles the server.
    for (const file of ["a%20b.txt", "%2Fsecret.txt", "data.json", "data.json.gz"]) {
      writeProjectFile(root, `.output/public/${file}`, "");
    }

    expect(nitro.options.plugins).toEqual(["#vinext/nitro-public-files"]);
    const template = nitro.options.virtual?.["#vinext/nitro-public-files"];
    expect(typeof template).toBe("function");
    // Keyed as Nitro keys its static files: decoded, then joined to `/`. A
    // file Nitro didn't copy to its output isn't listed.
    expect((template as () => string)()).toContain(
      'publicAssets: ["/a b.txt","/data.json","/data.json.gz","/secret.txt"]',
    );
  });

  it("lists the files in Vite's resolved public directory", async () => {
    const root = createPagesProject();
    writeProjectFile(root, "public/default.txt", "file\n");
    writeProjectFile(root, "static/custom.txt", "file\n");
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    writeProjectFile(root, ".output/public/default.txt", "file\n");
    writeProjectFile(root, ".output/public/custom.txt", "file\n");
    const nitro: NitroSetupTarget = {
      options: {
        dev: false,
        preset: "node-server",
        baseURL: "/",
        serveStatic: true,
        output: { publicDir: path.join(root, ".output/public") },
      },
    };

    (nitroPlugin.configResolved as (config: { publicDir: string }) => void)({
      publicDir: path.join(root, "static"),
    });
    await runNitroSetup(nitroPlugin, nitro);

    const template = nitro.options.virtual?.["#vinext/nitro-public-files"] as () => string;
    expect(template()).toContain('publicAssets: ["/custom.txt"]');
  });

  it.each([
    ["in dev", { dev: true, serveStatic: true }],
    ["when Nitro doesn't serve static files", { dev: false, serveStatic: false }],
    [
      "on AWS Amplify, whose CDN serves them",
      { dev: false, preset: "aws_amplify", serveStatic: true },
    ],
    ["under a Nitro baseURL", { dev: false, baseURL: "/docs/", serveStatic: true }],
  ])("does not register the public files plugin %s", async (_, options) => {
    const nitroPlugin = await initializeNitroSetupPlugin(createAppProject());
    const nitro: NitroSetupTarget = { options };

    await runNitroSetup(nitroPlugin, nitro);

    expect(nitro.options.plugins).toBeUndefined();
    expect(nitro.options.virtual).toBeUndefined();
  });

  it("propagates server externals during Nitro dev", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro: NitroSetupTarget = {
      options: {
        dev: true,
        routeRules: {},
        traceDeps: ["existing-trace"],
      },
    };

    await runNitroSetup(nitroPlugin, nitro);

    expect(nitro.options.routeRules).toEqual({});
    const traceDeps = nitro.options.traceDeps ?? [];
    expect(traceDeps.filter((dep) => typeof dep === "string")).toEqual(["existing-trace"]);
    expect(isTracedByNitro(traceDeps, "/app/node_modules/pg/lib/index.js")).toBe(true);
    expect(isTracedByNitro(traceDeps, "/app/node_modules/mongodb/lib/index.js")).toBe(true);
  });
});

describe("nitroTracedExternals", () => {
  it("leaves out packages a user `!name` traceDeps or noExternals entry keeps bundled", () => {
    const traced = nitroTracedExternals(
      ["pg", "mongodb", "sharp", "typescript", "@prisma/client"],
      {
        traceDeps: ["!pg", "!sharp*", "sharp", /mongodb/],
        noExternals: ["typescript", /^@prisma\//],
      },
    );
    expect([...traced.packages]).toEqual(["mongodb", "sharp"]);
    expect([...nitroTracedExternals(["pg"], { noExternals: true }).packages]).toEqual(["pg"]);
    expect([...nitroTracedExternals(["pg"]).packages]).toEqual(["pg"]);
  });

  it("matches noExternals like Nitro: a RegExp, or a string anywhere in an id or file", () => {
    const { bundles } = nitroTracedExternals([], { noExternals: ["node_modules/pg/", /^sharp$/] });
    expect(bundles("/app/node_modules/pg/lib/index.js")).toBe(true);
    expect(bundles("/app/node_modules/pg-pool/index.js")).toBe(false);
    expect(bundles("sharp")).toBe(true);
    expect(bundles("sharp/lib")).toBe(false);
  });

  it("leaves the lastIndex of a user's global noExternals RegExp alone", () => {
    const pattern = /^pg$/g;
    const { bundles } = nitroTracedExternals(["pg"], { noExternals: [pattern] });
    expect(bundles("pg")).toBe(true);
    expect(bundles("pg")).toBe(true);
    expect(pattern.lastIndex).toBe(0);
  });
});
