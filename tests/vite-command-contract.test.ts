import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const CLI_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const VP_PATH = path.resolve(import.meta.dirname, "../node_modules/.bin/vp");
const VITE_CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.resolve("vite"))), "cli.js");
const VINEXT_ENTRY_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js"),
).href;
const temporaryProjects: string[] = [];

function write(root: string, file: string, contents: string): void {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function createHybridProject(configFile = "vite.config.ts"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-vite-command-contract-"));
  temporaryProjects.push(root);
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  write(root, "package.json", '{"type":"module"}\n');
  write(
    root,
    configFile,
    `import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};

if (process.env.FROM_DOTENV !== "config-time-dotenv") {
  throw new Error("dotenv unavailable in Vite config: " + process.env.FROM_DOTENV);
}
if (process.env.EXPECT_CONFIG_NODE_ENV && process.env.NODE_ENV !== process.env.EXPECT_CONFIG_NODE_ENV) {
  throw new Error("vite.config saw NODE_ENV=" + process.env.NODE_ENV);
}

export default defineConfig({
  build: { manifest: true, target: "es2020" },
  environments: {
    ssr: {
      build: {
        target: "es2022",
        rolldownOptions: { output: [{ chunkFileNames: "chunks/[name].js" }] },
      },
    },
  },
  resolve: {
    alias: { "virtual:contract-value": path.join(import.meta.dirname, "contract-value.ts") },
  },
  define: { __TOP_LEVEL_MARKER__: JSON.stringify("top-level-config-ran") },
  plugins: [
    {
      name: "contract:config-only",
      config() {
        return { define: { __CONFIG_ONLY_MARKER__: JSON.stringify("config-only-plugin-ran") } };
      },
    },
    {
      name: "contract:config-resolved-output",
      configResolved(config) {
        fs.mkdirSync(path.join(config.root, "dist"), { recursive: true });
        fs.writeFileSync(path.join(config.root, "dist/config-resolved-plugin-ran"), "ok");
      },
    },
    {
      name: "contract:ssr-only",
      apply(_config, env) {
        return env.isSsrBuild;
      },
      transform(code, id) {
        if (!id.endsWith("/pages/legacy.tsx")) return;
        return code.replace("__SSR_ONLY_MARKER__", JSON.stringify("ssr-only-plugin-ran"));
      },
    },
    {
      name: "contract:ssr-environment",
      configEnvironment(name) {
        if (name === "ssr") {
          return { define: { __SSR_ENV_MARKER__: JSON.stringify("ssr-environment-ran") } };
        }
      },
    },
    {
      name: "contract:output-only",
      writeBundle() {
        const outDir = this.environment.config.build.outDir;
        if (outDir.endsWith("dist/server")) {
          const countPath = path.join(outDir, "output-only-plugin-count");
          const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf-8")) : 0;
          fs.writeFileSync(
            path.join(outDir, "output-only-plugin-ran"),
            this.environment.name + ":" + this.environment.config.build.target,
          );
          fs.writeFileSync(countPath, String(count + 1));
        }
      },
    },
    vinext({
      rscOutDir: "custom/server",
      ssrOutDir: "custom/server/ssr",
    }),
  ],
});
`,
  );
  write(
    root,
    "next.config.mjs",
    `if (process.env.EXPECT_CONFIG_NODE_ENV && process.env.NODE_ENV !== process.env.EXPECT_CONFIG_NODE_ENV) {
  throw new Error("next.config saw NODE_ENV=" + process.env.NODE_ENV);
}
export default {};
`,
  );
  write(root, ".env", "FROM_DOTENV=config-time-dotenv\n");
  write(root, "contract-value.ts", 'export const aliasMarker = "top-level-alias-ran";\n');
  write(
    root,
    "app/layout.tsx",
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  write(
    root,
    "app/page.tsx",
    `declare const __CONFIG_ONLY_MARKER__: string;
export default function Page() {
  return <p>{[__CONFIG_ONLY_MARKER__, process.env.NODE_ENV === "production" ? "vinext-production-marker" : "vinext-development-marker"].join(":")}</p>;
}
`,
  );
  write(
    root,
    "pages/legacy.tsx",
    `import { aliasMarker } from "virtual:contract-value";
declare const __CONFIG_ONLY_MARKER__: string;
declare const __TOP_LEVEL_MARKER__: string;
declare const __SSR_ONLY_MARKER__: string;
declare const __SSR_ENV_MARKER__: string;
export default function LegacyPage() {
  return <p>{[aliasMarker, __CONFIG_ONLY_MARKER__, __TOP_LEVEL_MARKER__, __SSR_ONLY_MARKER__, __SSR_ENV_MARKER__, process.env.NODE_ENV === "production" ? "vinext-pages-production-marker" : "vinext-pages-development-marker"].join(":")}</p>;
}
`,
  );
  return root;
}

function createPagesProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-vite-pages-contract-"));
  temporaryProjects.push(root);
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  write(root, "package.json", '{"type":"module"}\n');
  write(
    root,
    "vite.config.ts",
    `import fs from "node:fs";
import { defineConfig } from "vite";
import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
export default defineConfig({
  plugins: [
    vinext({ nextConfig: { generateBuildId: async () => null }, prerender: true }),
    {
      name: "record-builder-config",
      configResolved(config) {
        fs.writeFileSync(config.root + "/builder.json", JSON.stringify(config.builder));
      },
    },
  ],
});
`,
  );
  write(root, "pages/index.tsx", "export default function Page() { return <p>pages</p>; }\n");
  return root;
}

afterEach(() => {
  for (const project of temporaryProjects.splice(0)) {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

describe("configured vinext build contract", () => {
  function expectConfiguredBuild(root: string): void {
    expect(fs.existsSync(path.join(root, "custom/server/index.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "custom/server/ssr/index.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/client"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "dist/config-resolved-plugin-ran"), "utf-8")).toBe("ok");

    const pagesEntry = fs.readFileSync(path.join(root, "dist/server/entry.js"), "utf-8");
    expect(pagesEntry).toContain("top-level-alias-ran");
    expect(pagesEntry).toContain("config-only-plugin-ran");
    expect(pagesEntry).toContain("vinext-pages-production-marker");
    expect(pagesEntry).not.toContain("vinext-pages-development-marker");
    expect(pagesEntry).toContain("top-level-config-ran");
    expect(pagesEntry).toContain("ssr-only-plugin-ran");
    expect(pagesEntry).toContain("ssr-environment-ran");
    expect(pagesEntry).not.toContain("__CONFIG_ONLY_MARKER__");
    expect(fs.readFileSync(path.join(root, "dist/server/output-only-plugin-ran"), "utf-8")).toBe(
      "ssr:es2022",
    );
    expect(fs.readFileSync(path.join(root, "dist/server/output-only-plugin-count"), "utf-8")).toBe(
      "1",
    );
    const serverManifest = JSON.parse(
      fs.readFileSync(path.join(root, "custom/server/.vite/manifest.json"), "utf-8"),
    ) as Record<string, { isEntry?: boolean }>;
    expect(serverManifest["virtual:vinext-rsc-entry"]?.isEntry).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/server/.vite/manifest.json"))).toBe(false);

    const appOutput = fs
      .globSync("**/*.js", { cwd: path.join(root, "custom/server") })
      .map((file) => fs.readFileSync(path.join(root, "custom/server", file), "utf-8"))
      .join("\n");
    expect(appOutput).toContain("config-only-plugin-ran");
    expect(appOutput).toContain("vinext-production-marker");
    expect(appOutput).not.toContain("vinext-development-marker");
    expect(appOutput).not.toContain("__CONFIG_ONLY_MARKER__");
  }

  it("keeps hybrid config plugins, custom output roots, and production semantics", () => {
    const root = createHybridProject();

    execFileSync(process.execPath, [CLI_PATH, "build"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "development" },
      stdio: "pipe",
      timeout: 120_000,
    });

    expectConfiguredBuild(root);
  }, 120_000);

  it.each<[string, string[], "test" | "development", "test" | undefined]>([
    ["default mode with NODE_ENV=test", [], "test", "test"],
    ["test mode with NODE_ENV=test", ["--mode", "test"], "test", "test"],
    ["default mode with NODE_ENV=development", [], "development", undefined],
  ])(
    "provides the same lifecycle for %s",
    (_, modeArgs, nodeEnv, expectedConfigNodeEnv) => {
      // Next.js preserves an explicit NODE_ENV while loading config, but still
      // compiles production branches during build.
      // Ported from Next.js: test/e2e/non-standard-node-env-warning/non-standard-node-env-warning.test.ts
      // https://github.com/vercel/next.js/blob/canary/test/e2e/non-standard-node-env-warning/non-standard-node-env-warning.test.ts
      const root = createHybridProject("vite.prod.ts");
      write(root, "vite.config.ts", 'throw new Error("loaded the wrong Vite config");\n');

      execFileSync(
        process.execPath,
        [VITE_CLI_PATH, "build", root, ...modeArgs, "--config", "vite.prod.ts"],
        {
          cwd: root,
          env: {
            ...process.env,
            ...(expectedConfigNodeEnv ? { EXPECT_CONFIG_NODE_ENV: expectedConfigNodeEnv } : {}),
            NODE_ENV: nodeEnv,
          },
          stdio: "pipe",
          timeout: 120_000,
        },
      );

      expectConfiguredBuild(root);
    },
    120_000,
  );

  it("builds only the known client and server environments for plain Pages projects", () => {
    const root = createPagesProject();

    execFileSync(VP_PATH, ["build"], { cwd: root, stdio: "pipe" });

    expect(fs.existsSync(path.join(root, "dist/client/.vite/manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/server/entry.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/server/prerendered-routes/index.html"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, "builder.json"), "utf-8"))).toMatchObject({
      sharedConfigBuild: true,
    });
    const buildId = fs.readFileSync(path.join(root, "dist/server/BUILD_ID"), "utf-8");
    expect(buildId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(path.join(root, "dist/client/_next/static", buildId))).toBe(true);
    const serverEntry = fs.readFileSync(path.join(root, "dist/server/entry.js"), "utf-8");
    expect(serverEntry).toContain(buildId);
    expect(serverEntry).not.toContain("process.env.__VINEXT_REVALIDATE_SECRET");
  }, 120_000);

  it("keeps raw emptyOutDir false as the cleanup escape hatch", () => {
    const root = createHybridProject();
    const configPath = path.join(root, "vite.config.ts");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf-8")
        .replace(
          'build: { manifest: true, target: "es2020" },',
          'build: { emptyOutDir: false, manifest: true, target: "es2020" },',
        )
        .replace(
          "plugins: [",
          `plugins: [{
    name: "override-empty-out-dir",
    config() { return { build: { emptyOutDir: true } }; },
  },`,
        ),
    );
    write(root, "dist/keep.txt", "keep");

    execFileSync(process.execPath, [CLI_PATH, "build"], {
      cwd: root,
      stdio: "pipe",
      timeout: 120_000,
    });

    expect(fs.readFileSync(path.join(root, "dist/keep.txt"), "utf-8")).toBe("keep");
  }, 120_000);

  it("keeps the vinext build report when Vite logging is silent", () => {
    const root = createHybridProject();
    const configPath = path.join(root, "vite.config.ts");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf-8")
        .replace(
          "export default defineConfig({",
          'export default defineConfig({ logLevel: "silent",',
        ),
    );

    const output = execFileSync(process.execPath, [CLI_PATH, "build"], {
      cwd: root,
      encoding: "utf-8",
      stdio: "pipe",
    });

    expect(output).toContain("Build complete.");
  }, 120_000);

  it("leaves explicitly targeted Vite builds outside the application lifecycle", () => {
    const root = createPagesProject();
    write(root, "entry.ts", 'export const marker = "targeted-build";\n');
    const configPath = path.join(root, "vite.config.ts");
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, "utf-8").replace(
        "plugins: [",
        `plugins: [{
    name: "late-targeted-build",
    config: {
      order: "post",
      handler() { return { build: { rolldownOptions: { input: "entry.ts" } } }; },
    },
  },`,
      ),
    );
    write(root, "dist/keep.txt", "keep");

    const output = execFileSync(VP_PATH, ["build"], {
      cwd: root,
      encoding: "utf-8",
      stdio: "pipe",
    });

    expect(output).not.toContain("Build complete.");
    expect(fs.existsSync(path.join(root, "dist/server/prerendered-routes"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "dist/keep.txt"), "utf-8")).toBe("keep");
  }, 120_000);
});
