import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";

const tempDirs: string[] = [];

type NitroSetupTarget = {
  options: {
    dev?: boolean;
    routeRules?: Record<string, Record<string, unknown>>;
    traceDeps?: string[];
  };
};

type NitroSetupPlugin = {
  nitro?: {
    setup?: (nitro: NitroSetupTarget) => Promise<void> | void;
  };
} & Plugin;

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
  it("propagates server externals to Nitro traceDeps", async () => {
    const root = createAppProject();
    writeProjectFile(
      root,
      "next.config.mjs",
      `export default { serverExternalPackages: ["custom-apm", "@scope/traced"] };\n`,
    );
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = {
      options: {
        dev: false,
        routeRules: {},
        traceDeps: ["existing-trace", "pg"],
      },
    };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.traceDeps?.slice(0, 2)).toEqual(["existing-trace", "pg"]);
    expect(nitro.options.traceDeps).toContain("pg");
    expect(nitro.options.traceDeps).toContain("mongodb");
    expect(nitro.options.traceDeps).toContain("custom-apm");
    expect(nitro.options.traceDeps).toContain("@scope/traced");
    expect(new Set(nitro.options.traceDeps).size).toBe(nitro.options.traceDeps?.length);
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

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.routeRules).toEqual({
      "/blog/*": { headers: { "x-test": "1" } },
    });
  });

  it("does not add Nitro cache rules for Pages Router getStaticProps revalidate routes", async () => {
    const root = createPagesProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = { options: { dev: false, routeRules: {} } };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.routeRules).toEqual({});
  });

  it("propagates server externals during Nitro dev", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = {
      options: {
        dev: true,
        routeRules: {},
        traceDeps: ["existing-trace"],
      },
    };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.routeRules).toEqual({});
    expect(nitro.options.traceDeps?.slice(0, 1)).toEqual(["existing-trace"]);
    expect(nitro.options.traceDeps).toContain("pg");
    expect(nitro.options.traceDeps).toContain("mongodb");
  });
});
