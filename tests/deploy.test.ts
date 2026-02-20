import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  detectProject,
  generateWranglerConfig,
  generateAppRouterWorkerEntry,
  generatePagesRouterWorkerEntry,
  generateAppRouterViteConfig,
  generatePagesRouterViteConfig,
  getMissingDeps,
  getFilesToGenerate,
  ensureESModule,
  renameCJSConfigs,
} from "../packages/vinext/src/deploy.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-deploy-test-"));
  return dir;
}

function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function mkdir(dir: string, relativePath: string): void {
  fs.mkdirSync(path.join(dir, relativePath), { recursive: true });
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── detectProject ──────────────────────────────────────────────────────────

describe("detectProject", () => {
  it("detects App Router when app/ exists", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/page.tsx", "export default function Home() { return <div>hi</div> }");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
    expect(info.isPagesRouter).toBe(false);
  });

  it("detects Pages Router when only pages/ exists", () => {
    mkdir(tmpDir, "pages");
    writeFile(tmpDir, "pages/index.tsx", "export default function Home() { return <div>hi</div> }");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(false);
    expect(info.isPagesRouter).toBe(true);
  });

  it("prefers App Router when both app/ and pages/ exist", () => {
    mkdir(tmpDir, "app");
    mkdir(tmpDir, "pages");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
    expect(info.isPagesRouter).toBe(false);
  });

  it("detects neither when no app/ or pages/", () => {
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(false);
    expect(info.isPagesRouter).toBe(false);
  });

  it("detects vite.config.ts", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "vite.config.ts", "export default {}");
    const info = detectProject(tmpDir);
    expect(info.hasViteConfig).toBe(true);
  });

  it("detects vite.config.mjs", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "vite.config.mjs", "export default {}");
    const info = detectProject(tmpDir);
    expect(info.hasViteConfig).toBe(true);
  });

  it("detects no vite config", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    expect(info.hasViteConfig).toBe(false);
  });

  it("detects wrangler.jsonc", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "wrangler.jsonc", "{}");
    const info = detectProject(tmpDir);
    expect(info.hasWranglerConfig).toBe(true);
  });

  it("detects wrangler.toml", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "wrangler.toml", "[vars]");
    const info = detectProject(tmpDir);
    expect(info.hasWranglerConfig).toBe(true);
  });

  it("detects worker/index.ts", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "worker/index.ts", "export default {}");
    const info = detectProject(tmpDir);
    expect(info.hasWorkerEntry).toBe(true);
  });

  it("detects worker/index.js", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "worker/index.js", "export default {}");
    const info = detectProject(tmpDir);
    expect(info.hasWorkerEntry).toBe(true);
  });

  it("derives project name from package.json", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "my-cool-app" }));
    const info = detectProject(tmpDir);
    expect(info.projectName).toBe("my-cool-app");
  });

  it("strips npm scope from project name", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "@org/my-app" }));
    const info = detectProject(tmpDir);
    expect(info.projectName).toBe("my-app");
  });

  it("sanitizes project name for Workers", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "My App_v2!" }));
    const info = detectProject(tmpDir);
    // Workers names: lowercase alphanumeric + hyphens
    expect(info.projectName).toMatch(/^[a-z0-9-]+$/);
    expect(info.projectName).not.toMatch(/^-|-$/);
  });

  it("falls back to directory name when no package.json", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    expect(info.projectName).toBe(path.basename(tmpDir));
  });

  it("detects ISR usage in App Router", () => {
    mkdir(tmpDir, "app");
    writeFile(
      tmpDir,
      "app/posts/page.tsx",
      `export const revalidate = 60;\nexport default function Posts() { return <div>posts</div> }`,
    );
    const info = detectProject(tmpDir);
    expect(info.hasISR).toBe(true);
  });

  it("does not detect ISR when no revalidate export", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/page.tsx", "export default function Home() { return <div>hi</div> }");
    const info = detectProject(tmpDir);
    expect(info.hasISR).toBe(false);
  });

  it("does not detect ISR for Pages Router", () => {
    mkdir(tmpDir, "pages");
    writeFile(tmpDir, "pages/index.tsx", "export default function Home() { return <div>hi</div> }");
    const info = detectProject(tmpDir);
    expect(info.hasISR).toBe(false);
  });
});

// ─── generateWranglerConfig ─────────────────────────────────────────────────

describe("generateWranglerConfig", () => {
  it("generates valid JSON with required fields", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    const config = generateWranglerConfig(info);
    const parsed = JSON.parse(config);

    expect(parsed.name).toBe(info.projectName);
    expect(parsed.compatibility_flags).toContain("nodejs_compat");
    expect(parsed.main).toBe("./worker/index.ts");
    expect(parsed.assets).toEqual({ not_found_handling: "none", binding: "ASSETS" });
    expect(parsed.$schema).toBe("node_modules/wrangler/config-schema.json");
  });

  it("sets compatibility_date to today", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    const config = generateWranglerConfig(info);
    const parsed = JSON.parse(config);

    const today = new Date().toISOString().split("T")[0];
    expect(parsed.compatibility_date).toBe(today);
  });

  it("includes KV namespace when ISR detected", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/page.tsx", "export const revalidate = 30;\nexport default function() { return <div/> }");
    const info = detectProject(tmpDir);
    const config = generateWranglerConfig(info);
    const parsed = JSON.parse(config);

    expect(parsed.kv_namespaces).toBeDefined();
    expect(parsed.kv_namespaces[0].binding).toBe("VINEXT_CACHE");
  });

  it("omits KV namespace when no ISR", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/page.tsx", "export default function() { return <div/> }");
    const info = detectProject(tmpDir);
    const config = generateWranglerConfig(info);
    const parsed = JSON.parse(config);

    expect(parsed.kv_namespaces).toBeUndefined();
  });

  it("includes Cloudflare Images binding for image optimization", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    const config = generateWranglerConfig(info);
    const parsed = JSON.parse(config);

    expect(parsed.images).toBeDefined();
    expect(parsed.images.binding).toBe("IMAGES");
  });
});

// ─── Worker Entry Generation ─────────────────────────────────────────────────

describe("generateAppRouterWorkerEntry", () => {
  it("generates valid TypeScript", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("export default");
    expect(content).toContain("async fetch(request: Request, env: Env)");
    expect(content).toContain("Promise<Response>");
  });

  it("uses import.meta.viteRsc.loadModule", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain('import.meta.viteRsc.loadModule("rsc", "index")');
  });

  it("includes error handling", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("catch (error)");
    expect(content).toContain("Internal Server Error");
  });

  it("includes auto-generated comment", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("auto-generated by vinext deploy");
  });

  it("includes /_vinext/image handler", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("/_vinext/image");
    expect(content).toContain("handleImageOptimization");
  });

  it("declares Env interface with IMAGES binding", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("interface Env");
    expect(content).toContain("IMAGES");
    expect(content).toContain("ASSETS");
  });

  it("handles image format negotiation from Accept header", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("image/avif");
    expect(content).toContain("image/webp");
    expect(content).toContain("image/jpeg");
  });

  it("blocks non-relative URLs in image optimization", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("Only relative URLs allowed");
    // Uses allowlist: must start with "/" but not "//"
    expect(content).toContain('!imageUrl.startsWith("/")');
    expect(content).toContain('imageUrl.startsWith("//")');
  });

  it("sets Vary: Accept header on optimized image responses", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain('"Vary", "Accept"');
  });

  it("validates width and quality ranges in image handler", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("Number.isNaN(width)");
    expect(content).toContain("quality < 1");
    expect(content).toContain("quality > 100");
  });
});

describe("generatePagesRouterWorkerEntry", () => {
  it("generates valid TypeScript", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("export default");
    expect(content).toContain("async fetch(request: Request, env: Env)");
    expect(content).toContain("Promise<Response>");
  });

  it("imports from virtual:vinext-server-entry", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain('from "virtual:vinext-server-entry"');
    expect(content).toContain("renderPage");
    expect(content).toContain("handleApiRoute");
  });

  it("routes /api/ to handleApiRoute", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain('pathname.startsWith("/api/")');
    expect(content).toContain("handleApiRoute");
  });

  it("includes error handling", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("catch (error)");
    expect(content).toContain("Internal Server Error");
  });

  it("includes /_vinext/image handler", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("/_vinext/image");
    expect(content).toContain("handleImageOptimization");
  });

  it("declares Env interface with IMAGES binding", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("interface Env");
    expect(content).toContain("IMAGES");
    expect(content).toContain("ASSETS");
  });
});

// ─── Vite Config Generation ─────────────────────────────────────────────��───

describe("generateAppRouterViteConfig", () => {
  it("includes vinext, rsc, and cloudflare plugins", () => {
    const content = generateAppRouterViteConfig();
    expect(content).toContain('import vinext from "vinext"');
    expect(content).toContain('import rsc from "@vitejs/plugin-rsc"');
    expect(content).toContain('from "@cloudflare/vite-plugin"');
    expect(content).toContain("vinext()");
    expect(content).toContain("rsc(");
    expect(content).toContain("cloudflare(");
  });

  it("configures RSC entries correctly", () => {
    const content = generateAppRouterViteConfig();
    expect(content).toContain("virtual:vinext-rsc-entry");
    expect(content).toContain("virtual:vinext-app-ssr-entry");
    expect(content).toContain("virtual:vinext-app-browser-entry");
  });

  it("configures childEnvironments for Workers", () => {
    const content = generateAppRouterViteConfig();
    expect(content).toContain('childEnvironments: ["rsc", "ssr"]');
  });
});

describe("generatePagesRouterViteConfig", () => {
  it("includes vinext and cloudflare plugins only", () => {
    const content = generatePagesRouterViteConfig();
    expect(content).toContain('import vinext from "vinext"');
    expect(content).toContain('from "@cloudflare/vite-plugin"');
    expect(content).toContain("vinext()");
    expect(content).toContain("cloudflare()");
    // Should NOT include RSC plugin
    expect(content).not.toContain("plugin-rsc");
  });
});

// ─── getMissingDeps ──────────────────────────────────────────────────────────

describe("getMissingDeps", () => {
  it("reports missing @cloudflare/vite-plugin", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = false;
    info.hasWrangler = true;
    info.hasRscPlugin = true;

    const missing = getMissingDeps(info);
    expect(missing).toContainEqual(
      expect.objectContaining({ name: "@cloudflare/vite-plugin" }),
    );
  });

  it("reports missing wrangler", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = false;
    info.hasRscPlugin = true;

    const missing = getMissingDeps(info);
    expect(missing).toContainEqual(
      expect.objectContaining({ name: "wrangler" }),
    );
  });

  it("reports missing @vitejs/plugin-rsc for App Router", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = false;

    const missing = getMissingDeps(info);
    expect(missing).toContainEqual(
      expect.objectContaining({ name: "@vitejs/plugin-rsc" }),
    );
  });

  it("does not require @vitejs/plugin-rsc for Pages Router", () => {
    mkdir(tmpDir, "pages");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = false;

    const missing = getMissingDeps(info);
    expect(missing).not.toContainEqual(
      expect.objectContaining({ name: "@vitejs/plugin-rsc" }),
    );
  });

  it("returns empty array when everything is installed", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = true;

    const missing = getMissingDeps(info);
    expect(missing).toHaveLength(0);
  });
});

// ─── getFilesToGenerate ──────────────────────────────────────────────────────

describe("getFilesToGenerate", () => {
  it("generates all three files when nothing exists (App Router)", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    expect(files).toHaveLength(3);
    const descriptions = files.map((f) => f.description);
    expect(descriptions).toContain("wrangler.jsonc");
    expect(descriptions).toContain("worker/index.ts");
    expect(descriptions).toContain("vite.config.ts");
  });

  it("generates all three files when nothing exists (Pages Router)", () => {
    mkdir(tmpDir, "pages");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    expect(files).toHaveLength(3);
  });

  it("skips wrangler.jsonc when it already exists", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "wrangler.jsonc", "{}");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    const descriptions = files.map((f) => f.description);
    expect(descriptions).not.toContain("wrangler.jsonc");
    expect(files).toHaveLength(2);
  });

  it("skips worker/index.ts when it already exists", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "worker/index.ts", "export default {}");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    const descriptions = files.map((f) => f.description);
    expect(descriptions).not.toContain("worker/index.ts");
  });

  it("skips vite.config.ts when it already exists", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "vite.config.ts", "export default {}");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    const descriptions = files.map((f) => f.description);
    expect(descriptions).not.toContain("vite.config.ts");
  });

  it("generates nothing when all files exist", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "wrangler.jsonc", "{}");
    writeFile(tmpDir, "worker/index.ts", "export default {}");
    writeFile(tmpDir, "vite.config.ts", "export default {}");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    expect(files).toHaveLength(0);
  });

  it("generates App Router worker entry for App Router project", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    const workerFile = files.find((f) => f.description === "worker/index.ts");
    expect(workerFile).toBeDefined();
    expect(workerFile!.content).toContain("viteRsc.loadModule");
    expect(workerFile!.content).not.toContain("virtual:vinext-server-entry");
  });

  it("generates Pages Router worker entry for Pages Router project", () => {
    mkdir(tmpDir, "pages");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    const workerFile = files.find((f) => f.description === "worker/index.ts");
    expect(workerFile).toBeDefined();
    expect(workerFile!.content).toContain("virtual:vinext-server-entry");
    expect(workerFile!.content).not.toContain("viteRsc");
  });

  it("generates App Router vite config for App Router project", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    const viteFile = files.find((f) => f.description === "vite.config.ts");
    expect(viteFile).toBeDefined();
    expect(viteFile!.content).toContain("plugin-rsc");
    expect(viteFile!.content).toContain("childEnvironments");
  });

  it("generates Pages Router vite config for Pages Router project", () => {
    mkdir(tmpDir, "pages");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    const viteFile = files.find((f) => f.description === "vite.config.ts");
    expect(viteFile).toBeDefined();
    expect(viteFile!.content).not.toContain("plugin-rsc");
  });
});

// ─── ensureESModule ──────────────────────────────────────────────────────────

describe("ensureESModule", () => {
  it("adds 'type': 'module' when missing", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "test-app" }));

    const added = ensureESModule(tmpDir);
    expect(added).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.type).toBe("module");
  });

  it("returns false when already has 'type': 'module'", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "test-app", type: "module" }));

    const added = ensureESModule(tmpDir);
    expect(added).toBe(false);
  });

  it("returns false when no package.json", () => {
    const added = ensureESModule(tmpDir);
    expect(added).toBe(false);
  });

  it("preserves existing package.json fields", () => {
    writeFile(
      tmpDir,
      "package.json",
      JSON.stringify({
        name: "test-app",
        version: "1.0.0",
        dependencies: { react: "^19.0.0" },
      }),
    );

    ensureESModule(tmpDir);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("test-app");
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.dependencies.react).toBe("^19.0.0");
    expect(pkg.type).toBe("module");
  });
});

// ─── renameCJSConfigs ────────────────────────────────────────────────────────

describe("renameCJSConfigs", () => {
  it("renames postcss.config.js using module.exports to .cjs", () => {
    writeFile(tmpDir, "postcss.config.js", "module.exports = { plugins: {} };");

    const renamed = renameCJSConfigs(tmpDir);
    expect(renamed).toEqual([["postcss.config.js", "postcss.config.cjs"]]);
    expect(fs.existsSync(path.join(tmpDir, "postcss.config.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "postcss.config.js"))).toBe(false);
  });

  it("renames tailwind.config.js using require() to .cjs", () => {
    writeFile(tmpDir, "tailwind.config.js", `const plugin = require("tailwindcss/plugin");\nmodule.exports = {};`);

    const renamed = renameCJSConfigs(tmpDir);
    expect(renamed).toEqual([["tailwind.config.js", "tailwind.config.cjs"]]);
  });

  it("does not rename ESM config files", () => {
    writeFile(tmpDir, "postcss.config.js", "export default { plugins: {} };");

    const renamed = renameCJSConfigs(tmpDir);
    expect(renamed).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, "postcss.config.js"))).toBe(true);
  });

  it("renames multiple CJS configs at once", () => {
    writeFile(tmpDir, "postcss.config.js", "module.exports = {};");
    writeFile(tmpDir, "tailwind.config.js", "module.exports = {};");
    writeFile(tmpDir, ".eslintrc.js", "module.exports = {};");

    const renamed = renameCJSConfigs(tmpDir);
    expect(renamed).toHaveLength(3);
    expect(renamed.map((r) => r[0])).toContain("postcss.config.js");
    expect(renamed.map((r) => r[0])).toContain("tailwind.config.js");
    expect(renamed.map((r) => r[0])).toContain(".eslintrc.js");
  });

  it("returns empty array when no CJS configs exist", () => {
    const renamed = renameCJSConfigs(tmpDir);
    expect(renamed).toEqual([]);
  });
});

// ─── detectProject: new fields ──────────────────────────────────────────────

describe("detectProject — new detection features", () => {
  it("detects hasTypeModule when package.json has type: module", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "test", type: "module" }));
    const info = detectProject(tmpDir);
    expect(info.hasTypeModule).toBe(true);
  });

  it("hasTypeModule is false when missing", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "test" }));
    const info = detectProject(tmpDir);
    expect(info.hasTypeModule).toBe(false);
  });

  it("detects MDX via .mdx files in app/", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/about/page.mdx", "# About\nHello world");
    const info = detectProject(tmpDir);
    expect(info.hasMDX).toBe(true);
  });

  it("detects MDX via @next/mdx in next.config", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "next.config.mjs", `import mdx from "@next/mdx";\nexport default mdx()({});`);
    const info = detectProject(tmpDir);
    expect(info.hasMDX).toBe(true);
  });

  it("hasMDX is false when no MDX usage", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/page.tsx", "export default function Home() { return <div/> }");
    const info = detectProject(tmpDir);
    expect(info.hasMDX).toBe(false);
  });

  it("detects CodeHike dependency", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ dependencies: { codehike: "^1.0.0" } }));
    const info = detectProject(tmpDir);
    expect(info.hasCodeHike).toBe(true);
  });

  it("hasCodeHike is false when not a dependency", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    const info = detectProject(tmpDir);
    expect(info.hasCodeHike).toBe(false);
  });

  it("detects native modules to stub", () => {
    mkdir(tmpDir, "app");
    writeFile(
      tmpDir,
      "package.json",
      JSON.stringify({ dependencies: { "@resvg/resvg-js": "^2.0.0", satori: "^0.10.0" } }),
    );
    const info = detectProject(tmpDir);
    expect(info.nativeModulesToStub).toContain("@resvg/resvg-js");
    expect(info.nativeModulesToStub).toContain("satori");
  });

  it("nativeModulesToStub is empty when no native deps", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    const info = detectProject(tmpDir);
    expect(info.nativeModulesToStub).toEqual([]);
  });
});

// ─── Generated Vite config with new features ────────────────────────────────

describe("generateAppRouterViteConfig — with project info", () => {
  it("delegates MDX to vinext plugin auto-injection (no separate mdx() call)", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/about/page.mdx", "# About");
    const info = detectProject(tmpDir);
    const config = generateAppRouterViteConfig(info);
    // MDX is now handled by the vinext plugin's auto-injection at runtime,
    // not by a separate mdx() call in the generated config.
    expect(config).toContain("vinext()");
    expect(config).toContain("auto-injects @mdx-js/rollup");
    expect(config).not.toContain('import mdx from "@mdx-js/rollup"');
  });

  it("does not include CodeHike plugins in generated config (handled by vinext plugin)", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/about/page.mdx", "# About");
    writeFile(tmpDir, "package.json", JSON.stringify({ dependencies: { codehike: "^1.0.0" } }));
    const info = detectProject(tmpDir);
    const config = generateAppRouterViteConfig(info);
    // CodeHike plugins are extracted from next.config at runtime by the vinext plugin
    expect(config).not.toContain("remarkCodeHike");
    expect(config).not.toContain("recmaCodeHike");
    expect(config).toContain("vinext()");
  });

  it("does not include tsconfig aliases in generated config (handled by plugin at runtime)", () => {
    mkdir(tmpDir, "app");
    writeFile(
      tmpDir,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "#/*": ["./*"] } },
      }),
    );
    const info = detectProject(tmpDir);
    const config = generateAppRouterViteConfig(info);
    expect(config).not.toContain('"#"');
  });

  it("includes native module stubs in resolve.alias", () => {
    mkdir(tmpDir, "app");
    writeFile(
      tmpDir,
      "package.json",
      JSON.stringify({ dependencies: { "@resvg/resvg-js": "^2.0.0" } }),
    );
    const info = detectProject(tmpDir);
    const config = generateAppRouterViteConfig(info);
    expect(config).toContain("@resvg/resvg-js");
    expect(config).toContain("empty-stub.js");
  });

  it("still works without info (backward compatible)", () => {
    const config = generateAppRouterViteConfig();
    expect(config).toContain("vinext()");
    expect(config).toContain("rsc(");
    expect(config).toContain("cloudflare(");
    // Generated config no longer includes a separate mdx() import/call
    expect(config).not.toContain('import mdx from "@mdx-js/rollup"');
    expect(config).not.toContain("resolve:");
  });
});

describe("generatePagesRouterViteConfig — with project info", () => {
  it("does not include tsconfig aliases in generated config (handled by plugin at runtime)", () => {
    mkdir(tmpDir, "pages");
    writeFile(
      tmpDir,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
    );
    const info = detectProject(tmpDir);
    const config = generatePagesRouterViteConfig(info);
    expect(config).not.toContain('"@"');
  });

  it("still works without info (backward compatible)", () => {
    const config = generatePagesRouterViteConfig();
    expect(config).toContain("vinext()");
    expect(config).toContain("cloudflare()");
    expect(config).not.toContain("resolve:");
  });
});

// ─── getMissingDeps with MDX ─────────────────────────────────────────────────

describe("getMissingDeps — MDX", () => {
  it("reports @mdx-js/rollup when MDX detected but not installed", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/about/page.mdx", "# About");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = true;
    const missing = getMissingDeps(info);
    expect(missing).toContainEqual(expect.objectContaining({ name: "@mdx-js/rollup" }));
  });
});

// ─── Integration: Full Detection of Real Fixtures ────────────────────────────

describe("detectProject on real fixtures", () => {
  const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");

  it("detects app-router-cloudflare fixture correctly", () => {
    const cfApp = path.join(fixturesDir, "app-router-cloudflare");
    if (!fs.existsSync(cfApp)) return; // skip if not available

    const info = detectProject(cfApp);
    expect(info.isAppRouter).toBe(true);
    expect(info.hasViteConfig).toBe(true);
    expect(info.hasWranglerConfig).toBe(true);
    expect(info.hasWorkerEntry).toBe(true);
  });

  it("detects pages-router-cloudflare fixture correctly", () => {
    const cfPages = path.join(fixturesDir, "pages-router-cloudflare");
    if (!fs.existsSync(cfPages)) return; // skip if not available

    const info = detectProject(cfPages);
    expect(info.isPagesRouter).toBe(true);
    expect(info.hasViteConfig).toBe(true);
    expect(info.hasWranglerConfig).toBe(true);
    expect(info.hasWorkerEntry).toBe(true);
  });

  it("generates zero files for fully-configured app-router-cloudflare", () => {
    const cfApp = path.join(fixturesDir, "app-router-cloudflare");
    if (!fs.existsSync(cfApp)) return;

    const info = detectProject(cfApp);
    const files = getFilesToGenerate(info);
    expect(files).toHaveLength(0);
  });

  it("generates zero files for fully-configured pages-router-cloudflare", () => {
    const cfPages = path.join(fixturesDir, "pages-router-cloudflare");
    if (!fs.existsSync(cfPages)) return;

    const info = detectProject(cfPages);
    const files = getFilesToGenerate(info);
    expect(files).toHaveLength(0);
  });

  it("would report missing deps for non-cloudflare fixture", () => {
    const pagesBasic = path.join(fixturesDir, "pages-basic");
    if (!fs.existsSync(pagesBasic)) return;

    const info = detectProject(pagesBasic);
    // pages-basic doesn't have @cloudflare/vite-plugin or wrangler in its own node_modules
    // (it uses the hoisted root node_modules), but the check is per-project
    // The important thing: getMissingDeps respects the detected flags
    info.hasCloudflarePlugin = false;
    info.hasWrangler = false;
    const missing = getMissingDeps(info);
    expect(missing.length).toBeGreaterThan(0);
  });
});
