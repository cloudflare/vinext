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
    expect(parsed.assets).toEqual({ not_found_handling: "none" });
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
});

// ─── Worker Entry Generation ─────────────────────────────────────────────────

describe("generateAppRouterWorkerEntry", () => {
  it("generates valid TypeScript", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("export default");
    expect(content).toContain("async fetch(request: Request)");
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
});

describe("generatePagesRouterWorkerEntry", () => {
  it("generates valid TypeScript", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("export default");
    expect(content).toContain("async fetch(request: Request)");
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

// ─── Integration: Full Detection of Real Fixtures ────────────────────────────

describe("detectProject on real fixtures", () => {
  const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");

  it("detects cloudflare-app fixture correctly", () => {
    const cfApp = path.join(fixturesDir, "cloudflare-app");
    if (!fs.existsSync(cfApp)) return; // skip if not available

    const info = detectProject(cfApp);
    expect(info.isAppRouter).toBe(true);
    expect(info.hasViteConfig).toBe(true);
    expect(info.hasWranglerConfig).toBe(true);
    expect(info.hasWorkerEntry).toBe(true);
  });

  it("detects cloudflare-pages fixture correctly", () => {
    const cfPages = path.join(fixturesDir, "cloudflare-pages");
    if (!fs.existsSync(cfPages)) return; // skip if not available

    const info = detectProject(cfPages);
    expect(info.isPagesRouter).toBe(true);
    expect(info.hasViteConfig).toBe(true);
    expect(info.hasWranglerConfig).toBe(true);
    expect(info.hasWorkerEntry).toBe(true);
  });

  it("generates zero files for fully-configured cloudflare-app", () => {
    const cfApp = path.join(fixturesDir, "cloudflare-app");
    if (!fs.existsSync(cfApp)) return;

    const info = detectProject(cfApp);
    const files = getFilesToGenerate(info);
    expect(files).toHaveLength(0);
  });

  it("generates zero files for fully-configured cloudflare-pages", () => {
    const cfPages = path.join(fixturesDir, "cloudflare-pages");
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
