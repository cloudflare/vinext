import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { setupCloudflarePlatform } from "../packages/vinext/src/init-cloudflare.js";
import { addScripts } from "../packages/vinext/src/init.js";

const repositoryRoot = process.cwd();
const projectNodeModules = path.join(
  repositoryRoot,
  "examples/pages-router-cloudflare/node_modules",
);
const noCloudflareAdapters = {
  dataCache: "none" as const,
  cdnCache: "data-cache" as const,
  imageOptimization: "none" as const,
};

let tmpDir: string | undefined;

function writeFile(relativePath: string, content: string): void {
  if (!tmpDir) throw new Error("Test directory is not initialized.");
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("Cloudflare init build output", () => {
  it("emits the Pages Router config at the scaffolded deploy path", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-init-cloudflare-build-"));
    fs.symlinkSync(projectNodeModules, path.join(tmpDir, "node_modules"), "junction");
    writeFile(
      "package.json",
      JSON.stringify({ name: "@scope/MyApp", private: true, type: "module", scripts: {} }),
    );
    writeFile("pages/index.tsx", "export default function Page() { return <main>hello</main>; }\n");
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "root-worker-name",
        compatibility_date: "2026-08-18",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: {
          directory: "dist/client",
          not_found_handling: "none",
          binding: "ASSETS",
        },
      }),
    );
    writeFile(
      "worker.wrangler.jsonc",
      JSON.stringify({
        compatibility_date: "2026-08-18",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: {
          directory: "dist/client",
          not_found_handling: "none",
          binding: "ASSETS",
        },
      }),
    );
    writeFile(
      "vite.config.ts",
      `import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext(), cloudflare({ configPath: "./worker.wrangler.jsonc" })],
});
`,
    );
    setupCloudflarePlatform(
      {
        root: tmpDir,
        isAppRouter: false,
        existingViteConfigPath: path.join(tmpDir, "vite.config.ts"),
        today: "2026-08-18",
      },
      noCloudflareAdapters,
    );
    addScripts(tmpDir, false, "cloudflare", { scriptNames: "standard" });

    const viteConfig = fs.readFileSync(path.join(tmpDir, "vite.config.ts"), "utf-8");
    expect(viteConfig).toContain('configPath: "./worker.wrangler.jsonc"');
    expect(viteConfig).not.toContain("viteEnvironment");
    expect(viteConfig).toContain('"scope__y_pp": {');

    const builder = await createBuilder({ root: tmpDir, logLevel: "silent" });
    await builder.buildApp();

    const packageJson = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    expect(packageJson.scripts.deploy).toBe(
      "vinext-cloudflare deploy --config dist/server/wrangler.json",
    );
    expect(fs.existsSync(path.join(tmpDir, "dist/server/wrangler.json"))).toBe(true);
  });

  it("uses Wrangler's project-name fallback for a nameless root config", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-init-cloudflare-build-"));
    fs.symlinkSync(projectNodeModules, path.join(tmpDir, "node_modules"), "junction");
    writeFile(
      "package.json",
      JSON.stringify({ name: "@scope/MyApp", private: true, type: "module", scripts: {} }),
    );
    writeFile("pages/index.tsx", "export default function Page() { return <main>hello</main>; }\n");
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        compatibility_date: "2026-08-18",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: {
          directory: "dist/client",
          not_found_handling: "none",
          binding: "ASSETS",
        },
      }),
    );
    setupCloudflarePlatform(
      { root: tmpDir, isAppRouter: false, today: "2026-08-18" },
      noCloudflareAdapters,
    );
    addScripts(tmpDir, false, "cloudflare", { scriptNames: "standard" });

    const viteConfig = fs.readFileSync(path.join(tmpDir, "vite.config.ts"), "utf-8");
    expect(viteConfig).toContain("cloudflare()");
    expect(viteConfig).not.toContain("viteEnvironment");
    expect(viteConfig).toContain('"scope__y_pp": {');

    const builder = await createBuilder({ root: tmpDir, logLevel: "silent" });
    await builder.buildApp();

    expect(fs.existsSync(path.join(tmpDir, "dist/server/wrangler.json"))).toBe(true);
  });

  it("uses the generated Worker name when scaffolding without a Wrangler config", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-init-cloudflare-build-"));
    fs.symlinkSync(projectNodeModules, path.join(tmpDir, "node_modules"), "junction");
    writeFile(
      "package.json",
      JSON.stringify({ name: "@scope/MyApp", private: true, type: "module", scripts: {} }),
    );
    writeFile("pages/index.tsx", "export default function Page() { return <main>hello</main>; }\n");
    setupCloudflarePlatform(
      { root: tmpDir, isAppRouter: false, today: "2026-08-18" },
      noCloudflareAdapters,
    );
    addScripts(tmpDir, false, "cloudflare", { scriptNames: "standard" });

    const wranglerConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "wrangler.jsonc"), "utf-8"),
    );
    expect(wranglerConfig.name).toBe("myapp");
    const viteConfig = fs.readFileSync(path.join(tmpDir, "vite.config.ts"), "utf-8");
    expect(viteConfig).toContain("cloudflare()");
    expect(viteConfig).not.toContain("viteEnvironment");
    expect(viteConfig).toContain('"myapp": {');

    const builder = await createBuilder({ root: tmpDir, logLevel: "silent" });
    await builder.buildApp();

    expect(fs.existsSync(path.join(tmpDir, "dist/server/wrangler.json"))).toBe(true);
  });
});
