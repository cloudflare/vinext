/**
 * vinext deploy — one-command Cloudflare Workers deployment.
 *
 * Takes any Next.js app and deploys it to Cloudflare Workers:
 *
 *   1. Detects App Router vs Pages Router
 *   2. Auto-generates missing config files (wrangler.jsonc, worker/index.ts, vite.config.ts)
 *   3. Ensures dependencies are installed (@cloudflare/vite-plugin, wrangler, @vitejs/plugin-rsc)
 *   4. Runs the Vite build
 *   5. Deploys to Cloudflare Workers via wrangler
 *
 * Design: Everything is auto-generated into a `.vinext/` directory (not the
 * project root) to avoid cluttering the user's project. If the user already
 * has these files, we use theirs.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync, type ExecSyncOptions } from "node:child_process";
import { createBuilder, build } from "vite";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeployOptions {
  /** Project root directory */
  root: string;
  /** Deploy to preview environment (default: production) */
  preview?: boolean;
  /** Custom project name for the Worker */
  name?: string;
  /** Skip the build step (assume already built) */
  skipBuild?: boolean;
  /** Dry run — generate config files but don't build or deploy */
  dryRun?: boolean;
}

interface ProjectInfo {
  root: string;
  isAppRouter: boolean;
  isPagesRouter: boolean;
  hasViteConfig: boolean;
  hasWranglerConfig: boolean;
  hasWorkerEntry: boolean;
  hasCloudflarePlugin: boolean;
  hasRscPlugin: boolean;
  hasWrangler: boolean;
  projectName: string;
  /** Pages that use `revalidate` (ISR) */
  hasISR: boolean;
}

// ─── Detection ───────────────────────────────────────────────────────────────

export function detectProject(root: string): ProjectInfo {
  const hasApp = fs.existsSync(path.join(root, "app"));
  const hasPages = fs.existsSync(path.join(root, "pages"));

  // Prefer App Router if both exist
  const isAppRouter = hasApp;
  const isPagesRouter = !hasApp && hasPages;

  const hasViteConfig =
    fs.existsSync(path.join(root, "vite.config.ts")) ||
    fs.existsSync(path.join(root, "vite.config.js")) ||
    fs.existsSync(path.join(root, "vite.config.mjs"));

  const hasWranglerConfig =
    fs.existsSync(path.join(root, "wrangler.jsonc")) ||
    fs.existsSync(path.join(root, "wrangler.json")) ||
    fs.existsSync(path.join(root, "wrangler.toml"));

  const hasWorkerEntry =
    fs.existsSync(path.join(root, "worker", "index.ts")) ||
    fs.existsSync(path.join(root, "worker", "index.js"));

  // Check node_modules for installed packages
  const hasCloudflarePlugin = fs.existsSync(
    path.join(root, "node_modules", "@cloudflare", "vite-plugin"),
  );
  const hasRscPlugin = fs.existsSync(
    path.join(root, "node_modules", "@vitejs", "plugin-rsc"),
  );
  const hasWrangler = fs.existsSync(
    path.join(root, "node_modules", ".bin", "wrangler"),
  );

  // Derive project name from package.json or directory name
  let projectName = path.basename(root);
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.name) {
        // Sanitize: Workers names must be lowercase alphanumeric + hyphens
        projectName = pkg.name
          .replace(/^@[^/]+\//, "") // strip npm scope
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");
      }
    } catch {
      // ignore parse errors
    }
  }

  // Detect ISR usage (rough heuristic: search for `revalidate` exports)
  const hasISR = detectISR(root, isAppRouter);

  return {
    root,
    isAppRouter,
    isPagesRouter,
    hasViteConfig,
    hasWranglerConfig,
    hasWorkerEntry,
    hasCloudflarePlugin,
    hasRscPlugin,
    hasWrangler,
    projectName,
    hasISR,
  };
}

function detectISR(root: string, isAppRouter: boolean): boolean {
  if (!isAppRouter) return false;
  try {
    const appDir = path.join(root, "app");
    if (!fs.existsSync(appDir)) return false;
    // Quick check: search .ts/.tsx files in app/ for `export const revalidate`
    return scanDirForPattern(appDir, /export\s+const\s+revalidate\s*=/);
  } catch {
    return false;
  }
}

function scanDirForPattern(dir: string, pattern: RegExp): boolean {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      if (scanDirForPattern(fullPath, pattern)) return true;
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (pattern.test(content)) return true;
      } catch {
        // skip unreadable files
      }
    }
  }
  return false;
}

// ─── File Generation ─────────────────────────────────────────────────────────

/** Generate wrangler.jsonc content */
export function generateWranglerConfig(info: ProjectInfo): string {
  const today = new Date().toISOString().split("T")[0];

  const config: Record<string, unknown> = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: info.projectName,
    compatibility_date: today,
    compatibility_flags: ["nodejs_compat"],
    main: "./worker/index.ts",
    assets: {
      not_found_handling: "none",
    },
  };

  if (info.hasISR) {
    config.kv_namespaces = [
      {
        binding: "VINEXT_CACHE",
        id: "<your-kv-namespace-id>",
      },
    ];
  }

  return JSON.stringify(config, null, 2) + "\n";
}

/** Generate worker/index.ts for App Router */
export function generateAppRouterWorkerEntry(): string {
  return `/**
 * Cloudflare Worker entry point — auto-generated by vinext deploy.
 * Edit freely or delete to regenerate on next deploy.
 */

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      // Load the RSC handler from the RSC environment.
      // @ts-expect-error — import.meta.viteRsc is injected by @vitejs/plugin-rsc
      const rscModule = await import.meta.viteRsc.loadModule("rsc", "index");

      const result = await rscModule.default(request);

      if (result instanceof Response) {
        return result;
      }

      if (result === null || result === undefined) {
        return new Response("Not Found", { status: 404 });
      }

      return new Response(String(result), { status: 200 });
    } catch (error) {
      console.error("[vinext] Worker error:", error);
      return new Response(
        \`Internal Server Error: \${error instanceof Error ? error.message : String(error)}\`,
        { status: 500 },
      );
    }
  },
};
`;
}

/** Generate worker/index.ts for Pages Router */
export function generatePagesRouterWorkerEntry(): string {
  return `/**
 * Cloudflare Worker entry point — auto-generated by vinext deploy.
 * Edit freely or delete to regenerate on next deploy.
 */

// @ts-expect-error — virtual module resolved by vinext at build time
import { renderPage, handleApiRoute } from "virtual:vinext-server-entry";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const urlWithQuery = pathname + url.search;

      // API routes
      if (pathname.startsWith("/api/") || pathname === "/api") {
        return await handleApiRoute(request, urlWithQuery);
      }

      // Page routes
      return await renderPage(request, urlWithQuery, null);
    } catch (error) {
      console.error("[vinext] Worker error:", error);
      return new Response(
        \`Internal Server Error: \${error instanceof Error ? error.message : String(error)}\`,
        { status: 500 },
      );
    }
  },
};
`;
}

/** Generate vite.config.ts for App Router */
export function generateAppRouterViteConfig(): string {
  return `import { defineConfig } from "vite";
import vinext from "vinext";
import rsc from "@vitejs/plugin-rsc";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    rsc({
      entries: {
        rsc: "virtual:vinext-rsc-entry",
        ssr: "virtual:vinext-app-ssr-entry",
        client: "virtual:vinext-app-browser-entry",
      },
    }),
    cloudflare({
      viteEnvironment: {
        childEnvironments: ["rsc", "ssr"],
      },
    }),
  ],
});
`;
}

/** Generate vite.config.ts for Pages Router */
export function generatePagesRouterViteConfig(): string {
  return `import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare(),
  ],
});
`;
}

// ─── Dependency Management ───────────────────────────────────────────────────

interface MissingDep {
  name: string;
  version: string;
}

export function getMissingDeps(info: ProjectInfo): MissingDep[] {
  const missing: MissingDep[] = [];

  if (!info.hasCloudflarePlugin) {
    missing.push({ name: "@cloudflare/vite-plugin", version: "latest" });
  }
  if (!info.hasWrangler) {
    missing.push({ name: "wrangler", version: "latest" });
  }
  if (info.isAppRouter && !info.hasRscPlugin) {
    missing.push({ name: "@vitejs/plugin-rsc", version: "latest" });
  }

  return missing;
}

function installDeps(root: string, deps: MissingDep[]): void {
  if (deps.length === 0) return;

  const depsStr = deps.map((d) => `${d.name}@${d.version}`).join(" ");
  const installCmd = detectPackageManager(root);

  console.log(`  Installing: ${deps.map((d) => d.name).join(", ")}`);
  execSync(`${installCmd} ${depsStr}`, {
    cwd: root,
    stdio: "inherit",
  });
}

function detectPackageManager(root: string): string {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm add -D";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn add -D";
  if (fs.existsSync(path.join(root, "bun.lockb"))) return "bun add -D";
  return "npm install -D";
}

// ─── File Writing ────────────────────────────────────────────────────────────

interface GeneratedFile {
  path: string;
  content: string;
  description: string;
}

export function getFilesToGenerate(info: ProjectInfo): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  if (!info.hasWranglerConfig) {
    files.push({
      path: path.join(info.root, "wrangler.jsonc"),
      content: generateWranglerConfig(info),
      description: "wrangler.jsonc",
    });
  }

  if (!info.hasWorkerEntry) {
    const workerContent = info.isAppRouter
      ? generateAppRouterWorkerEntry()
      : generatePagesRouterWorkerEntry();
    files.push({
      path: path.join(info.root, "worker", "index.ts"),
      content: workerContent,
      description: "worker/index.ts",
    });
  }

  if (!info.hasViteConfig) {
    const viteContent = info.isAppRouter
      ? generateAppRouterViteConfig()
      : generatePagesRouterViteConfig();
    files.push({
      path: path.join(info.root, "vite.config.ts"),
      content: viteContent,
      description: "vite.config.ts",
    });
  }

  return files;
}

function writeGeneratedFiles(files: GeneratedFile[]): void {
  for (const file of files) {
    const dir = path.dirname(file.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file.path, file.content, "utf-8");
    console.log(`  Created ${file.description}`);
  }
}

// ─── Build ───────────────────────────────────────────────────────────────────

async function runBuild(info: ProjectInfo): Promise<void> {
  console.log("\n  Building for Cloudflare Workers...\n");

  // Use Vite's JS API for the build. The user's vite.config.ts (or our
  // generated one) has the cloudflare() plugin which handles the Worker
  // output format. We just need to trigger the build.
  //
  // For App Router, createBuilder().buildApp() handles multi-environment builds.
  // For Pages Router, a single build() call suffices (cloudflare plugin manages it).

  if (info.isAppRouter) {
    const builder = await createBuilder({ root: info.root });
    await builder.buildApp();
  } else {
    await build({ root: info.root });
  }
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

function runWranglerDeploy(root: string, preview: boolean): string {
  const wranglerBin = path.join(root, "node_modules", ".bin", "wrangler");

  const execOpts: ExecSyncOptions = {
    cwd: root,
    stdio: "pipe",
    encoding: "utf-8",
  };

  // wrangler deploy outputs the URL to stdout
  const args = preview ? ["deploy", "--env", "preview"] : ["deploy"];
  const cmd = `"${wranglerBin}" ${args.join(" ")}`;

  console.log(preview ? "\n  Deploying to preview..." : "\n  Deploying to production...");

  const output = execSync(cmd, execOpts) as string;

  // Parse the deployed URL from wrangler output
  // Wrangler prints: "Published <name> (version_id)\n  https://<name>.<subdomain>.workers.dev"
  const urlMatch = output.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/);
  const deployedUrl = urlMatch ? urlMatch[0] : null;

  // Also print raw output for transparency
  if (output.trim()) {
    for (const line of output.trim().split("\n")) {
      console.log(`  ${line}`);
    }
  }

  return deployedUrl ?? "(URL not detected in wrangler output)";
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

export async function deploy(options: DeployOptions): Promise<void> {
  const root = path.resolve(options.root);

  console.log("\n  vinext deploy\n");

  // Step 1: Detect project structure
  const info = detectProject(root);

  if (!info.isAppRouter && !info.isPagesRouter) {
    console.error("  Error: No app/ or pages/ directory found.");
    console.error("  vinext deploy requires a Next.js project with app/ or pages/ directory.\n");
    process.exit(1);
  }

  if (options.name) {
    info.projectName = options.name;
  }

  console.log(`  Project: ${info.projectName}`);
  console.log(`  Router:  ${info.isAppRouter ? "App Router" : "Pages Router"}`);
  console.log(`  ISR:     ${info.hasISR ? "detected" : "none"}`);

  // Step 2: Check and install missing dependencies
  const missingDeps = getMissingDeps(info);
  if (missingDeps.length > 0) {
    console.log();
    installDeps(root, missingDeps);
    // Re-detect after install
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    if (info.isAppRouter) info.hasRscPlugin = true;
  }

  // Step 3: Generate missing config files
  const filesToGenerate = getFilesToGenerate(info);
  if (filesToGenerate.length > 0) {
    console.log();
    writeGeneratedFiles(filesToGenerate);
  }

  if (options.dryRun) {
    console.log("\n  Dry run complete. Files generated but no build or deploy performed.\n");
    return;
  }

  // Step 4: Build
  if (!options.skipBuild) {
    await runBuild(info);
  } else {
    console.log("\n  Skipping build (--skip-build)");
  }

  // Step 5: Deploy via wrangler
  const url = runWranglerDeploy(root, options.preview ?? false);

  console.log("\n  ─────────────────────────────────────────");
  console.log(`  Deployed to: ${url}`);
  console.log("  ─────────────────────────────────────────\n");
}
