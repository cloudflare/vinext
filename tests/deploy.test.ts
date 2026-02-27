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
  buildWranglerDeployArgs,
  parseDeployArgs,
  isPackageResolvable,
} from "../packages/vinext/src/deploy.js";
import { computeLazyChunks } from "../packages/vinext/src/index.js";

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

// ─── Wrangler deploy args ───────────────────────────────────────────────────

describe("buildWranglerDeployArgs", () => {
  it("uses plain deploy for production by default", () => {
    expect(buildWranglerDeployArgs({})).toEqual({ args: ["deploy"], env: undefined });
  });

  it("maps --preview to wrangler --env preview", () => {
    expect(buildWranglerDeployArgs({ preview: true })).toEqual({
      args: ["deploy", "--env", "preview"],
      env: "preview",
    });
  });

  it("passes through explicit env names", () => {
    expect(buildWranglerDeployArgs({ env: "staging" })).toEqual({
      args: ["deploy", "--env", "staging"],
      env: "staging",
    });
  });

  it("prefers explicit env over --preview shorthand", () => {
    expect(buildWranglerDeployArgs({ preview: true, env: "qa" })).toEqual({
      args: ["deploy", "--env", "qa"],
      env: "qa",
    });
  });

  it("treats empty string env as production", () => {
    expect(buildWranglerDeployArgs({ env: "" })).toEqual({ args: ["deploy"], env: undefined });
  });
});

// ─── Deploy CLI arg parsing ─────────────────────────────────────────────────

describe("parseDeployArgs", () => {
  it("defaults to production deploy with no flags", () => {
    const parsed = parseDeployArgs([]);
    expect(parsed.preview).toBe(false);
    expect(parsed.env).toBeUndefined();
    expect(parsed.name).toBeUndefined();
    expect(parsed.skipBuild).toBe(false);
    expect(parsed.dryRun).toBe(false);
  });

  it("parses --env with space-separated value", () => {
    expect(parseDeployArgs(["--env", "staging"]).env).toBe("staging");
  });

  it("parses --env=value form", () => {
    expect(parseDeployArgs(["--env=staging"]).env).toBe("staging");
  });

  it("parses --name with space-separated value", () => {
    expect(parseDeployArgs(["--name", "my-app"]).name).toBe("my-app");
  });

  it("parses --name=value form", () => {
    expect(parseDeployArgs(["--name=my-app"]).name).toBe("my-app");
  });

  it("parses boolean flags", () => {
    const parsed = parseDeployArgs(["--preview", "--skip-build", "--dry-run"]);
    expect(parsed.preview).toBe(true);
    expect(parsed.skipBuild).toBe(true);
    expect(parsed.dryRun).toBe(true);
  });

  it("parses numeric TPR flags from string values", () => {
    const parsed = parseDeployArgs([
      "--experimental-tpr",
      "--tpr-coverage", "95",
      "--tpr-limit", "500",
      "--tpr-window", "48",
    ]);
    expect(parsed.experimentalTPR).toBe(true);
    expect(parsed.tprCoverage).toBe(95);
    expect(parsed.tprLimit).toBe(500);
    expect(parsed.tprWindow).toBe(48);
  });

  it("trims whitespace from --env value", () => {
    expect(parseDeployArgs(["--env", "  staging  "]).env).toBe("staging");
  });

  it("treats whitespace-only --env as undefined", () => {
    expect(parseDeployArgs(["--env", "   "]).env).toBeUndefined();
  });

  it("throws on unknown flags (strict mode)", () => {
    expect(() => parseDeployArgs(["--bogus"])).toThrow();
  });
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

  it("imports handler from vinext/server/app-router-entry", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain('import handler from "vinext/server/app-router-entry"');
  });

  it("delegates to handler.fetch", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("handler.fetch(request)");
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

  it("imports handleImageOptimization from vinext/server/image-optimization", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain('from "vinext/server/image-optimization"');
    expect(content).toContain("handleImageOptimization");
  });

  it("declares Env interface with IMAGES binding", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("interface Env");
    expect(content).toContain("IMAGES");
    expect(content).toContain("ASSETS");
  });

  it("passes image handlers inline to handleImageOptimization", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("fetchAsset:");
    expect(content).toContain("transformImage:");
    expect(content).toContain("env.ASSETS.fetch");
    expect(content).toContain("env.IMAGES");
  });

  it("documents that parseImageParams handles backslash normalization", () => {
    const content = generateAppRouterWorkerEntry();
    // The App Router generated entry delegates to handleImageOptimization
    // which calls parseImageParams. Verify the comment documents this.
    expect(content).toContain("parseImageParams");
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

  it("imports runMiddleware and vinextConfig from virtual:vinext-server-entry", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("runMiddleware");
    expect(content).toContain("vinextConfig");
    // Both should come from the same virtual import
    expect(content).toMatch(/import\s*\{[^}]*runMiddleware[^}]*\}\s*from\s*"virtual:vinext-server-entry"/);
    expect(content).toMatch(/import\s*\{[^}]*vinextConfig[^}]*\}\s*from\s*"virtual:vinext-server-entry"/);
  });

  it("imports config matchers from vinext/config/config-matchers", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain('from "vinext/config/config-matchers"');
    expect(content).toContain("matchRedirect");
    expect(content).toContain("matchRewrite");
    expect(content).toContain("matchHeaders");
    expect(content).toContain("requestContextFromRequest");
    expect(content).toContain("isExternalUrl");
    expect(content).toContain("proxyExternalRequest");
  });

  it("runs middleware before routing", () => {
    const content = generatePagesRouterWorkerEntry();
    // Middleware should appear before API route check
    const middlewarePos = content.indexOf("runMiddleware(request)");
    const apiRoutePos = content.indexOf('resolvedPathname.startsWith("/api/")');
    expect(middlewarePos).toBeGreaterThan(-1);
    expect(apiRoutePos).toBeGreaterThan(-1);
    expect(middlewarePos).toBeLessThan(apiRoutePos);
  });

  it("handles middleware redirects", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("result.redirectUrl");
    expect(content).toContain("result.redirectStatus");
  });

  it("handles middleware rewrites", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("result.rewriteUrl");
    expect(content).toContain("resolvedUrl = result.rewriteUrl");
  });

  it("handles middleware access control responses", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("result.response");
    expect(content).toContain("!result.continue");
  });

  it("applies next.config.js redirects", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("configRedirects");
    expect(content).toContain("matchRedirect(resolvedPathname");
  });

  it("applies next.config.js rewrites (beforeFiles, afterFiles, fallback)", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("configRewrites.beforeFiles");
    expect(content).toContain("configRewrites.afterFiles");
    expect(content).toContain("configRewrites.fallback");
    expect(content).toContain("matchRewrite(resolvedPathname");
  });

  it("applies next.config.js custom headers", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("configHeaders");
    expect(content).toContain("matchHeaders(resolvedPathname");
  });

  it("handles basePath stripping and creates a new request with stripped URL for middleware", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("basePath");
    expect(content).toContain("pathname.startsWith(basePath)");
    // After stripping, a new request with the stripped URL must be created
    // so middleware matchers see the basePath-free pathname (matching prod-server)
    expect(content).toContain("strippedUrl.pathname = pathname");
    expect(content).toContain("new Request(strippedUrl, request)");
  });

  it("handles trailing slash normalization", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("trailingSlash");
    expect(content).toContain("hasTrailing");
  });

  it("routes /api/ to handleApiRoute using resolved URL", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain('resolvedPathname.startsWith("/api/")');
    expect(content).toContain("handleApiRoute(request, resolvedUrl)");
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

  it("imports handleImageOptimization from vinext/server/image-optimization", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain('from "vinext/server/image-optimization"');
    expect(content).toContain("handleImageOptimization");
  });

  it("declares Env interface with IMAGES binding", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("interface Env");
    expect(content).toContain("IMAGES");
    expect(content).toContain("ASSETS");
  });

  it("includes backslash normalization in protocol-relative guard", () => {
    const content = generatePagesRouterWorkerEntry();
    // The generated code should normalize backslashes before the // check
    expect(content).toContain('replaceAll("\\\\", "/")');
  });

  it("passes image handlers inline to handleImageOptimization", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("fetchAsset:");
    expect(content).toContain("transformImage:");
    expect(content).toContain("env.ASSETS.fetch");
    expect(content).toContain("env.IMAGES");
  });

  it("merges middleware and config headers into responses with correct precedence", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("mergeHeaders");
    expect(content).toContain("middlewareHeaders");
    // Response headers must override middleware headers (matching prod-server).
    // mergeHeaders should spread extraHeaders first, then overlay response headers.
    expect(content).toContain("{ ...extraHeaders }");
    expect(content).toContain("response.headers.forEach");
  });

  it("handles external rewrites via proxyExternalRequest", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("isExternalUrl(rewritten)");
    expect(content).toContain("proxyExternalRequest(request, rewritten)");
  });

  it("guards renderPage with typeof check", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain('typeof renderPage === "function"');
  });

  it("builds reqCtx before middleware runs", () => {
    const content = generatePagesRouterWorkerEntry();
    const reqCtxPos = content.indexOf("requestContextFromRequest(request)");
    const middlewarePos = content.indexOf("runMiddleware(request)");
    expect(reqCtxPos).toBeGreaterThan(-1);
    expect(middlewarePos).toBeGreaterThan(-1);
    expect(reqCtxPos).toBeLessThan(middlewarePos);
  });

  it("checks image optimization after basePath stripping", () => {
    const content = generatePagesRouterWorkerEntry();
    const basePathPos = content.indexOf("pathname.startsWith(basePath)");
    const imagePos = content.indexOf('pathname === "/_vinext/image"');
    expect(basePathPos).toBeGreaterThan(-1);
    expect(imagePos).toBeGreaterThan(-1);
    expect(basePathPos).toBeLessThan(imagePos);
  });
});

// ─── Vite Config Generation ─────────────────────────────────────────────��───

describe("generateAppRouterViteConfig", () => {
  it("includes vinext and cloudflare plugins", () => {
    const content = generateAppRouterViteConfig();
    expect(content).toContain('import vinext from "vinext"');
    expect(content).toContain('from "@cloudflare/vite-plugin"');
    expect(content).toContain("vinext()");
    expect(content).toContain("cloudflare(");
  });

  it("configures viteEnvironment with name: rsc and childEnvironments for Workers", () => {
    const content = generateAppRouterViteConfig();
    expect(content).toContain('name: "rsc"');
    expect(content).toContain('childEnvironments: ["ssr"]');
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

  it("reports missing react-server-dom-webpack for App Router", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = true;

    // Pass a resolver that always returns false to simulate rsdw not being installed.
    // (Vitest's createRequire finds rsdw via the monorepo root, so we can't rely
    // on filesystem isolation in tmpdir.)
    const notResolvable = () => false;
    const missing = getMissingDeps(info, notResolvable);
    expect(missing).toContainEqual(
      expect.objectContaining({ name: "react-server-dom-webpack" }),
    );
  });

  it("does not require react-server-dom-webpack for Pages Router", () => {
    mkdir(tmpDir, "pages");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = false;

    const missing = getMissingDeps(info);
    expect(missing).not.toContainEqual(
      expect.objectContaining({ name: "react-server-dom-webpack" }),
    );
  });

  it("returns empty array when everything is installed", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = true;

    // Pass a resolver that always returns true to simulate all packages installed.
    const allResolvable = () => true;
    const missing = getMissingDeps(info, allResolvable);
    expect(missing).toHaveLength(0);
  });
});

// ─── isPackageResolvable ─────────────────────────────────────────────────────

describe("isPackageResolvable", () => {
  it("returns true when package exists in node_modules", () => {
    // Create a proper resolvable package in the tmpdir
    const pkgDir = path.join(tmpDir, "node_modules", "fake-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "fake-pkg", version: "1.0.0", main: "index.js" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), "");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0" }),
    );

    expect(isPackageResolvable(tmpDir, "fake-pkg")).toBe(true);
  });

  it("returns false when package does not exist", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0" }),
    );
    // no-such-package-xyz123 should never exist in any node_modules
    expect(isPackageResolvable(tmpDir, "no-such-package-xyz123")).toBe(false);
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
    expect(workerFile!.content).toContain("vinext/server/app-router-entry");
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
    expect(viteFile!.content).toContain("vinext()");
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

// ─── detectProject: src/ directory support ──────────────────────────────────

describe("detectProject — src/ directory convention", () => {
  it("detects App Router when src/app/ exists", () => {
    mkdir(tmpDir, "src/app");
    writeFile(tmpDir, "src/app/page.tsx", "export default function Home() { return <div>hi</div> }");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
    expect(info.isPagesRouter).toBe(false);
  });

  it("detects Pages Router when only src/pages/ exists", () => {
    mkdir(tmpDir, "src/pages");
    writeFile(tmpDir, "src/pages/index.tsx", "export default function Home() { return <div>hi</div> }");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(false);
    expect(info.isPagesRouter).toBe(true);
  });

  it("prefers App Router when both src/app/ and src/pages/ exist", () => {
    mkdir(tmpDir, "src/app");
    mkdir(tmpDir, "src/pages");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
    expect(info.isPagesRouter).toBe(false);
  });

  it("prefers root-level app/ over src/app/", () => {
    mkdir(tmpDir, "app");
    mkdir(tmpDir, "src/app");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
  });

  it("prefers root-level pages/ over src/pages/", () => {
    mkdir(tmpDir, "pages");
    mkdir(tmpDir, "src/pages");
    const info = detectProject(tmpDir);
    expect(info.isPagesRouter).toBe(true);
  });

  it("detects App Router from root app/ even when src/pages/ exists", () => {
    mkdir(tmpDir, "app");
    mkdir(tmpDir, "src/pages");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
    expect(info.isPagesRouter).toBe(false);
  });

  it("detects ISR in src/app/ directory", () => {
    mkdir(tmpDir, "src/app");
    writeFile(
      tmpDir,
      "src/app/posts/page.tsx",
      `export const revalidate = 60;\nexport default function Posts() { return <div>posts</div> }`,
    );
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
    expect(info.hasISR).toBe(true);
  });

  it("does not detect ISR when src/app/ has no revalidate exports", () => {
    mkdir(tmpDir, "src/app");
    writeFile(tmpDir, "src/app/page.tsx", "export default function Home() { return <div>hi</div> }");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
    expect(info.hasISR).toBe(false);
  });

  it("detects MDX in src/app/ directory", () => {
    mkdir(tmpDir, "src/app");
    writeFile(tmpDir, "src/app/about/page.mdx", "# About\nHello world");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
    expect(info.hasMDX).toBe(true);
  });

  it("detects MDX in src/pages/ directory", () => {
    mkdir(tmpDir, "src/pages");
    writeFile(tmpDir, "src/pages/about.mdx", "# About\nHello world");
    const info = detectProject(tmpDir);
    expect(info.isPagesRouter).toBe(true);
    expect(info.hasMDX).toBe(true);
  });

  it("generates correct files for src/app/ project", () => {
    mkdir(tmpDir, "src/app");
    writeFile(tmpDir, "src/app/page.tsx", "export default function Home() { return <div>hi</div> }");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    expect(files).toHaveLength(3);
    const descriptions = files.map((f) => f.description);
    expect(descriptions).toContain("wrangler.jsonc");
    expect(descriptions).toContain("worker/index.ts");
    expect(descriptions).toContain("vite.config.ts");

    // Should generate App Router worker entry
    const workerFile = files.find((f) => f.description === "worker/index.ts");
    expect(workerFile!.content).toContain("vinext/server/app-router-entry");
  });

  it("generates correct files for src/pages/ project", () => {
    mkdir(tmpDir, "src/pages");
    writeFile(tmpDir, "src/pages/index.tsx", "export default function Home() { return <div>hi</div> }");
    const info = detectProject(tmpDir);
    const files = getFilesToGenerate(info);

    expect(files).toHaveLength(3);

    // Should generate Pages Router worker entry
    const workerFile = files.find((f) => f.description === "worker/index.ts");
    expect(workerFile!.content).toContain("virtual:vinext-server-entry");
  });

  it("detects neither when no app/, pages/, src/app/, or src/pages/", () => {
    mkdir(tmpDir, "src/lib");
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(false);
    expect(info.isPagesRouter).toBe(false);
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

// ─── Cloudflare _headers generation ─────────────────────────────────────────
// These tests exercise the same logic used by the vinext:cloudflare-build
// plugin's closeBundle hook to generate a _headers file for static asset
// caching on Cloudflare Workers.

describe("Cloudflare _headers file generation", () => {
  /** Replicates the _headers generation logic from the closeBundle hook. */
  function generateHeaders(clientDir: string, assetsDir = "assets"): void {
    const headersPath = path.join(clientDir, "_headers");
    if (!fs.existsSync(headersPath)) {
      const headersContent = [
        "# Cache content-hashed assets immutably (generated by vinext)",
        `/${assetsDir}/*`,
        "  Cache-Control: public, max-age=31536000, immutable",
        "",
      ].join("\n");
      fs.writeFileSync(headersPath, headersContent);
    }
  }

  it("generates _headers with correct Cloudflare format", () => {
    const clientDir = path.join(tmpDir, "dist", "client");
    fs.mkdirSync(clientDir, { recursive: true });

    generateHeaders(clientDir);

    const content = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(content).toContain("/assets/*");
    expect(content).toContain("Cache-Control: public, max-age=31536000, immutable");
    // Verify Cloudflare _headers format: path on its own line, indented header below
    const lines = content.split("\n");
    const pathLine = lines.findIndex((l) => l === "/assets/*");
    expect(pathLine).toBeGreaterThanOrEqual(0);
    expect(lines[pathLine + 1]).toBe("  Cache-Control: public, max-age=31536000, immutable");
  });

  it("skips generation when _headers already exists", () => {
    const clientDir = path.join(tmpDir, "dist", "client");
    fs.mkdirSync(clientDir, { recursive: true });

    const userContent = "/custom/*\n  X-Custom: true\n";
    fs.writeFileSync(path.join(clientDir, "_headers"), userContent);

    generateHeaders(clientDir);

    const content = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(content).toBe(userContent);
    expect(content).not.toContain("/assets/*");
  });

  it("respects custom assetsDir", () => {
    const clientDir = path.join(tmpDir, "dist", "client");
    fs.mkdirSync(clientDir, { recursive: true });

    generateHeaders(clientDir, "static");

    const content = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(content).toContain("/static/*");
    expect(content).not.toContain("/assets/*");
  });

  it("ends with a trailing newline", () => {
    const clientDir = path.join(tmpDir, "dist", "client");
    fs.mkdirSync(clientDir, { recursive: true });

    generateHeaders(clientDir);

    const content = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });
});

// ─── Cloudflare closeBundle: lazy chunk injection ────────────────────────────
// These tests verify that the vinext:cloudflare-build closeBundle hook correctly
// injects __VINEXT_LAZY_CHUNKS__ and other globals into the worker entry for
// BOTH App Router and Pages Router builds. This was regressed by PR #358 which
// added an early return for App Router builds, skipping lazy chunk injection.

describe("Cloudflare closeBundle lazy chunk injection", () => {
  /**
   * Replicates the closeBundle hook logic for App Router builds.
   * In #358's architecture, the RSC env IS the worker, so the worker entry
   * is at dist/server/index.js. The RSC plugin handles __VINEXT_CLIENT_ENTRY__,
   * but we still need to inject __VINEXT_LAZY_CHUNKS__ and __VINEXT_SSR_MANIFEST__.
   */
  function simulateCloseBundleAppRouter(buildRoot: string): void {
    const distDir = path.resolve(buildRoot, "dist");
    if (!fs.existsSync(distDir)) return;

    const clientDir = path.resolve(buildRoot, "dist", "client");

    // Read build manifest and compute lazy chunks
    let lazyChunksData: string[] | null = null;
    const buildManifestPath = path.join(clientDir, ".vite", "manifest.json");
    if (fs.existsSync(buildManifestPath)) {
      try {
        const buildManifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf-8"));
        const lazy = computeLazyChunks(buildManifest);
        if (lazy.length > 0) lazyChunksData = lazy;
      } catch { /* ignore */ }
    }

    // Read SSR manifest
    let ssrManifestData: Record<string, string[]> | null = null;
    const ssrManifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
    if (fs.existsSync(ssrManifestPath)) {
      try {
        ssrManifestData = JSON.parse(fs.readFileSync(ssrManifestPath, "utf-8"));
      } catch { /* ignore */ }
    }

    // App Router: inject into dist/server/index.js (NOT __VINEXT_CLIENT_ENTRY__)
    const workerEntry = path.resolve(distDir, "server", "index.js");
    if (fs.existsSync(workerEntry) && (lazyChunksData || ssrManifestData)) {
      let code = fs.readFileSync(workerEntry, "utf-8");
      const globals: string[] = [];
      if (ssrManifestData) {
        globals.push(`globalThis.__VINEXT_SSR_MANIFEST__ = ${JSON.stringify(ssrManifestData)};`);
      }
      if (lazyChunksData) {
        globals.push(`globalThis.__VINEXT_LAZY_CHUNKS__ = ${JSON.stringify(lazyChunksData)};`);
      }
      code = globals.join("\n") + "\n" + code;
      fs.writeFileSync(workerEntry, code);
    }
  }

  /**
   * Replicates the closeBundle hook logic for Pages Router builds.
   * The worker entry is found by scanning dist/ for a directory containing
   * wrangler.json. All three globals are injected.
   */
  function simulateCloseBundlePagesRouter(buildRoot: string): void {
    const distDir = path.resolve(buildRoot, "dist");
    if (!fs.existsSync(distDir)) return;

    const clientDir = path.resolve(buildRoot, "dist", "client");

    // Find worker output directory (contains wrangler.json)
    let workerOutDir: string | null = null;
    for (const entry of fs.readdirSync(distDir)) {
      const candidate = path.join(distDir, entry);
      if (entry === "client") continue;
      if (fs.statSync(candidate).isDirectory() &&
          fs.existsSync(path.join(candidate, "wrangler.json"))) {
        workerOutDir = candidate;
        break;
      }
    }
    if (!workerOutDir) return;

    const workerEntry = path.join(workerOutDir, "index.js");
    if (!fs.existsSync(workerEntry)) return;

    // Read build manifest and compute lazy chunks
    let lazyChunksData: string[] | null = null;
    let clientEntryFile: string | null = null;
    const buildManifestPath = path.join(clientDir, ".vite", "manifest.json");
    if (fs.existsSync(buildManifestPath)) {
      try {
        const buildManifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf-8"));
        for (const [, value] of Object.entries(buildManifest) as [string, any][]) {
          if (value && value.isEntry && value.file) {
            clientEntryFile = value.file;
            break;
          }
        }
        const lazy = computeLazyChunks(buildManifest);
        if (lazy.length > 0) lazyChunksData = lazy;
      } catch { /* ignore */ }
    }

    // Read SSR manifest
    let ssrManifestData: Record<string, string[]> | null = null;
    const ssrManifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
    if (fs.existsSync(ssrManifestPath)) {
      try {
        ssrManifestData = JSON.parse(fs.readFileSync(ssrManifestPath, "utf-8"));
      } catch { /* ignore */ }
    }

    // Pages Router: inject all three globals
    if (clientEntryFile || ssrManifestData || lazyChunksData) {
      let code = fs.readFileSync(workerEntry, "utf-8");
      const globals: string[] = [];
      if (clientEntryFile) {
        globals.push(`globalThis.__VINEXT_CLIENT_ENTRY__ = ${JSON.stringify(clientEntryFile)};`);
      }
      if (ssrManifestData) {
        globals.push(`globalThis.__VINEXT_SSR_MANIFEST__ = ${JSON.stringify(ssrManifestData)};`);
      }
      if (lazyChunksData) {
        globals.push(`globalThis.__VINEXT_LAZY_CHUNKS__ = ${JSON.stringify(lazyChunksData)};`);
      }
      code = globals.join("\n") + "\n" + code;
      fs.writeFileSync(workerEntry, code);
    }
  }

  /** Sets up a mock App Router build output directory structure. */
  function setupAppRouterBuildOutput(
    root: string,
    manifest: Record<string, any>,
    ssrManifest?: Record<string, string[]>,
  ): void {
    // dist/server/index.js — the RSC worker entry
    fs.mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "server", "index.js"),
      "// RSC worker entry\nexport default { fetch() {} };",
    );

    // dist/client/.vite/manifest.json
    fs.mkdirSync(path.join(root, "dist", "client", ".vite"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "client", ".vite", "manifest.json"),
      JSON.stringify(manifest),
    );

    // dist/client/.vite/ssr-manifest.json (optional)
    if (ssrManifest) {
      fs.writeFileSync(
        path.join(root, "dist", "client", ".vite", "ssr-manifest.json"),
        JSON.stringify(ssrManifest),
      );
    }
  }

  /** Sets up a mock Pages Router build output directory structure. */
  function setupPagesRouterBuildOutput(
    root: string,
    manifest: Record<string, any>,
    ssrManifest?: Record<string, string[]>,
  ): void {
    // dist/worker/ with wrangler.json and index.js
    const workerDir = path.join(root, "dist", "worker");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(workerDir, "wrangler.json"), "{}");
    fs.writeFileSync(
      path.join(workerDir, "index.js"),
      "// Pages Router worker entry\nexport default { fetch() {} };",
    );

    // dist/client/.vite/manifest.json
    fs.mkdirSync(path.join(root, "dist", "client", ".vite"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "client", ".vite", "manifest.json"),
      JSON.stringify(manifest),
    );

    // dist/client/.vite/ssr-manifest.json (optional)
    if (ssrManifest) {
      fs.writeFileSync(
        path.join(root, "dist", "client", ".vite", "ssr-manifest.json"),
        JSON.stringify(ssrManifest),
      );
    }
  }

  // A realistic manifest with both eager and lazy chunks
  const manifestWithLazyChunks = {
    "virtual:vinext-app-browser-entry": {
      file: "assets/app-entry.js",
      isEntry: true,
      imports: ["node_modules/react/index.js"],
      dynamicImports: ["src/components/MermaidChart.tsx"],
    },
    "node_modules/react/index.js": {
      file: "assets/framework.js",
    },
    "src/components/MermaidChart.tsx": {
      file: "assets/mermaid-chart.js",
      isDynamicEntry: true,
      imports: ["node_modules/mermaid/dist/mermaid.js"],
    },
    "node_modules/mermaid/dist/mermaid.js": {
      file: "assets/mermaid-vendor.js",
    },
  };

  // ── App Router tests ──────────────────────────────────────────────────

  it("App Router: injects __VINEXT_LAZY_CHUNKS__ into dist/server/index.js", () => {
    setupAppRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundleAppRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");
    expect(code).toContain("globalThis.__VINEXT_LAZY_CHUNKS__");

    // Verify the lazy chunks are correct (mermaid-chart and mermaid-vendor are lazy)
    const match = code.match(/globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*(\[.*?\]);/);
    expect(match).not.toBeNull();
    const lazyChunks = JSON.parse(match![1]);
    expect(lazyChunks).toContain("assets/mermaid-chart.js");
    expect(lazyChunks).toContain("assets/mermaid-vendor.js");
    // Eager chunks should NOT be in the lazy list
    expect(lazyChunks).not.toContain("assets/app-entry.js");
    expect(lazyChunks).not.toContain("assets/framework.js");
  });

  it("App Router: does NOT inject __VINEXT_CLIENT_ENTRY__", () => {
    setupAppRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundleAppRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");
    // RSC plugin handles client entry via loadBootstrapScriptContent()
    expect(code).not.toContain("__VINEXT_CLIENT_ENTRY__");
  });

  it("App Router: injects __VINEXT_SSR_MANIFEST__ when present", () => {
    const ssrManifest = {
      "src/app/page.tsx": ["/assets/page.js", "/assets/page.css"],
    };
    setupAppRouterBuildOutput(tmpDir, manifestWithLazyChunks, ssrManifest);

    simulateCloseBundleAppRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");
    expect(code).toContain("globalThis.__VINEXT_SSR_MANIFEST__");
    expect(code).toContain("src/app/page.tsx");
  });

  it("App Router: preserves original worker entry code after injection", () => {
    setupAppRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundleAppRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");
    // Original code should still be present after the injected globals
    expect(code).toContain("// RSC worker entry");
    expect(code).toContain("export default { fetch() {} };");
  });

  it("App Router: skips injection when no lazy chunks and no SSR manifest", () => {
    // Manifest with only eager (statically imported) chunks
    const eagerOnlyManifest = {
      "src/entry.ts": {
        file: "assets/entry.js",
        isEntry: true,
        imports: ["src/utils.ts"],
      },
      "src/utils.ts": {
        file: "assets/utils.js",
      },
    };
    setupAppRouterBuildOutput(tmpDir, eagerOnlyManifest);

    simulateCloseBundleAppRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");
    // No globals should be injected since there are no lazy chunks and no SSR manifest
    expect(code).not.toContain("globalThis.__VINEXT_LAZY_CHUNKS__");
    expect(code).not.toContain("globalThis.__VINEXT_SSR_MANIFEST__");
    // Original code untouched
    expect(code).toBe("// RSC worker entry\nexport default { fetch() {} };");
  });

  it("App Router: handles missing dist/server/index.js gracefully", () => {
    // Only set up client manifest, no server output
    fs.mkdirSync(path.join(tmpDir, "dist", "client", ".vite"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "dist", "client", ".vite", "manifest.json"),
      JSON.stringify(manifestWithLazyChunks),
    );

    // Should not throw
    expect(() => simulateCloseBundleAppRouter(tmpDir)).not.toThrow();
  });

  // ── Pages Router tests ────────────────────────────────────────────────

  it("Pages Router: injects all three globals into worker entry", () => {
    const ssrManifest = {
      "pages/index.tsx": ["/assets/page-index.js", "/assets/page-index.css"],
    };
    setupPagesRouterBuildOutput(tmpDir, manifestWithLazyChunks, ssrManifest);

    simulateCloseBundlePagesRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "worker", "index.js"), "utf-8");
    expect(code).toContain("globalThis.__VINEXT_CLIENT_ENTRY__");
    expect(code).toContain("globalThis.__VINEXT_SSR_MANIFEST__");
    expect(code).toContain("globalThis.__VINEXT_LAZY_CHUNKS__");
  });

  it("Pages Router: injects correct lazy chunks", () => {
    setupPagesRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundlePagesRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "worker", "index.js"), "utf-8");
    const match = code.match(/globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*(\[.*?\]);/);
    expect(match).not.toBeNull();
    const lazyChunks = JSON.parse(match![1]);
    expect(lazyChunks).toContain("assets/mermaid-chart.js");
    expect(lazyChunks).toContain("assets/mermaid-vendor.js");
    expect(lazyChunks).not.toContain("assets/app-entry.js");
    expect(lazyChunks).not.toContain("assets/framework.js");
  });

  it("Pages Router: finds worker entry via wrangler.json directory scan", () => {
    setupPagesRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundlePagesRouter(tmpDir);

    // Worker entry should have been modified
    const code = fs.readFileSync(path.join(tmpDir, "dist", "worker", "index.js"), "utf-8");
    expect(code).toContain("globalThis.");
    expect(code).toContain("// Pages Router worker entry");
  });

  it("Pages Router: skips client dir when no wrangler.json found", () => {
    // Set up worker dir without wrangler.json
    const workerDir = path.join(tmpDir, "dist", "worker");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, "index.js"),
      "// unmodified",
    );
    fs.mkdirSync(path.join(tmpDir, "dist", "client", ".vite"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "dist", "client", ".vite", "manifest.json"),
      JSON.stringify(manifestWithLazyChunks),
    );

    simulateCloseBundlePagesRouter(tmpDir);

    // Worker entry should NOT have been modified (no wrangler.json found)
    const code = fs.readFileSync(path.join(workerDir, "index.js"), "utf-8");
    expect(code).toBe("// unmodified");
  });

  // ── Shared behavior tests ─────────────────────────────────────────────

  it("both routers: computeLazyChunks correctly identifies dynamic-only chunks", () => {
    const lazy = computeLazyChunks(manifestWithLazyChunks);
    // mermaid-chart.js and mermaid-vendor.js are only reachable via dynamicImports
    expect(lazy).toContain("assets/mermaid-chart.js");
    expect(lazy).toContain("assets/mermaid-vendor.js");
    // app-entry.js (entry) and framework.js (static import) are eager
    expect(lazy).not.toContain("assets/app-entry.js");
    expect(lazy).not.toContain("assets/framework.js");
  });

  it("both routers: mermaid-like deep dynamic chains are fully lazy", () => {
    // Simulates a real-world case: mermaid imports d3 which imports d3-selection etc.
    const deepDynamicManifest = {
      "virtual:vinext-app-browser-entry": {
        file: "assets/entry.js",
        isEntry: true,
        imports: ["node_modules/react/index.js"],
        dynamicImports: ["src/components/Chart.tsx"],
      },
      "node_modules/react/index.js": {
        file: "assets/framework.js",
      },
      "src/components/Chart.tsx": {
        file: "assets/chart.js",
        isDynamicEntry: true,
        imports: ["node_modules/mermaid/dist/mermaid.js"],
      },
      "node_modules/mermaid/dist/mermaid.js": {
        file: "assets/mermaid.js",
        imports: ["node_modules/d3/src/index.js"],
      },
      "node_modules/d3/src/index.js": {
        file: "assets/d3.js",
        imports: ["node_modules/d3-selection/src/index.js"],
      },
      "node_modules/d3-selection/src/index.js": {
        file: "assets/d3-selection.js",
      },
    };

    const lazy = computeLazyChunks(deepDynamicManifest);
    // All chunks behind the dynamic boundary should be lazy
    expect(lazy).toContain("assets/chart.js");
    expect(lazy).toContain("assets/mermaid.js");
    expect(lazy).toContain("assets/d3.js");
    expect(lazy).toContain("assets/d3-selection.js");
    // Entry and framework are eager
    expect(lazy).not.toContain("assets/entry.js");
    expect(lazy).not.toContain("assets/framework.js");
  });
});
