import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  detectProject,
  deploy,
  generateWranglerConfig,
  generateAppRouterWorkerEntry,
  generatePagesRouterWorkerEntry,
  generateAppRouterViteConfig,
  generatePagesRouterViteConfig,
  getMissingDeps,
  getFilesToGenerate,
  ensureESModule,
  renameCJSConfigs,
  buildNodeCliInvocation,
  buildWranglerInvocation,
  buildWranglerDeployArgs,
  parseDeployArgs,
  resolveWranglerBin,
  runWranglerDeploy,
  validateWranglerEnvName,
  withCloudflareEnv,
  isPackageResolvable,
  viteConfigHasCloudflarePlugin,
  viteConfigHasCacheAdapter,
  workerEntryHasCacheHandler,
  hasWranglerConfig,
  formatMissingCloudflarePluginError,
  formatMissingCacheAdapterError,
} from "../packages/vinext/src/deploy.js";
import {
  detectPackageManager,
  detectPackageManagerName,
  findInNodeModules,
  ensureViteConfigCompatibility,
} from "../packages/vinext/src/utils/project.js";
import { scanPublicFileRoutes } from "../packages/vinext/src/utils/public-routes.js";
import { computeLazyChunks } from "../packages/vinext/src/utils/lazy-chunks.js";
import { isUnknownRecord } from "../packages/vinext/src/utils/record.js";
import {
  computeClientRuntimeMetadata,
  buildRuntimeGlobalsScript,
} from "../packages/vinext/src/utils/client-runtime-metadata.js";
import {
  mergeHeaders,
  resolveStaticAssetSignal,
} from "../packages/vinext/src/server/worker-utils.js";
import { domainCandidates, parseWranglerConfig } from "../packages/vinext/src/cloudflare/tpr.js";

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

function readVinextPackageExports(): Record<string, unknown> {
  const packageJsonPath = path.resolve("packages/vinext/package.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  if (!isUnknownRecord(parsed) || !isUnknownRecord(parsed.exports)) {
    throw new Error("packages/vinext/package.json must define an exports object");
  }
  return parsed.exports;
}

function extractVinextImportSubpaths(source: string): string[] {
  const imports = new Set<string>();
  const pattern = /\bfrom\s+["']vinext\/([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    imports.add(`./${match[1]}`);
  }
  return [...imports].sort();
}

function hasPackageExport(exportsMap: Record<string, unknown>, subpath: string): boolean {
  if (Object.hasOwn(exportsMap, subpath)) return true;

  for (const exportKey of Object.keys(exportsMap)) {
    if (!exportKey.includes("*")) continue;
    const [prefix, suffix] = exportKey.split("*");
    if (prefix === undefined || suffix === undefined) continue;
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) return true;
  }

  return false;
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

  it("preserves shell metacharacters as a literal environment argument", () => {
    const env = "preview & whoami > vinext-pwned.txt & rem";
    expect(buildWranglerDeployArgs({ env })).toEqual({
      args: ["deploy", "--env", env],
      env,
    });
  });

  it.each(["production", "preview-1", "staging_eu", "release.2026", "team/app @ 1"])(
    "accepts Wrangler environment name %s",
    (env) => {
      expect(validateWranglerEnvName(env)).toBe(env);
    },
  );

  it("rejects null bytes without imposing an artificial length limit", () => {
    expect(() => validateWranglerEnvName("preview\0prod")).toThrow("null bytes");
    expect(validateWranglerEnvName("a".repeat(1024))).toBe("a".repeat(1024));
  });
});

describe("deploy environment validation", () => {
  it("rejects invalid environment names before project side effects", async () => {
    writeFile(tmpDir, "package.json", '{"name":"unchanged"}\n');
    const before = fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8");

    await expect(deploy({ root: tmpDir, env: "preview\0prod", dryRun: true })).rejects.toThrow(
      "null bytes",
    );

    expect(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8")).toBe(before);
    expect(fs.existsSync(path.join(tmpDir, ".vinext"))).toBe(false);
  });
});

// ─── CLOUDFLARE_ENV propagation (issue #1210) ──────────────────────────────

describe("withCloudflareEnv", () => {
  let priorEnv: string | undefined;
  let priorHadEnv: boolean;

  beforeEach(() => {
    priorHadEnv = "CLOUDFLARE_ENV" in process.env;
    priorEnv = process.env.CLOUDFLARE_ENV;
    delete process.env.CLOUDFLARE_ENV;
  });

  afterEach(() => {
    if (priorHadEnv) {
      process.env.CLOUDFLARE_ENV = priorEnv;
    } else {
      delete process.env.CLOUDFLARE_ENV;
    }
  });

  it("sets CLOUDFLARE_ENV for the duration of the callback", async () => {
    let observed: string | undefined;
    await withCloudflareEnv("staging", async () => {
      observed = process.env.CLOUDFLARE_ENV;
    });
    expect(observed).toBe("staging");
  });

  it("restores absence of CLOUDFLARE_ENV after the callback when no prior value existed", async () => {
    await withCloudflareEnv("hml", async () => {
      // no-op
    });
    expect("CLOUDFLARE_ENV" in process.env).toBe(false);
  });

  it("restores the prior CLOUDFLARE_ENV value after the callback", async () => {
    process.env.CLOUDFLARE_ENV = "preview";
    await withCloudflareEnv("staging", async () => {
      expect(process.env.CLOUDFLARE_ENV).toBe("staging");
    });
    expect(process.env.CLOUDFLARE_ENV).toBe("preview");
  });

  it("does not touch process.env when env is undefined", async () => {
    let observed: string | undefined = "sentinel";
    await withCloudflareEnv(undefined, async () => {
      observed = process.env.CLOUDFLARE_ENV;
    });
    expect(observed).toBeUndefined();
    expect("CLOUDFLARE_ENV" in process.env).toBe(false);
  });

  it("does not touch process.env when env is empty string", async () => {
    await withCloudflareEnv("", async () => {
      expect("CLOUDFLARE_ENV" in process.env).toBe(false);
    });
    expect("CLOUDFLARE_ENV" in process.env).toBe(false);
  });

  it("restores CLOUDFLARE_ENV after the callback throws", async () => {
    process.env.CLOUDFLARE_ENV = "preview";
    await expect(
      withCloudflareEnv("staging", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env.CLOUDFLARE_ENV).toBe("preview");
  });

  it("returns the callback's resolved value", async () => {
    const result = await withCloudflareEnv("staging", async () => 42);
    expect(result).toBe(42);
  });
});

// ─── Wrangler JavaScript entrypoint resolution ──────────────────────────────

describe("resolveWranglerBin", () => {
  function writeWranglerPackage(
    bin: string | Record<string, string> = { wrangler: "bin/wrangler.js" },
  ) {
    writeFile(
      tmpDir,
      "node_modules/wrangler/package.json",
      JSON.stringify({ name: "wrangler", bin }),
    );
    writeFile(tmpDir, "node_modules/wrangler/bin/wrangler.js", "#!/usr/bin/env node");
  }

  function expectedWranglerBin(): string {
    return fs.realpathSync(path.join(tmpDir, "node_modules", "wrangler", "bin", "wrangler.js"));
  }

  it("resolves the JavaScript entrypoint from Wrangler's bin map", () => {
    writeWranglerPackage();
    expect(resolveWranglerBin(tmpDir)).toBe(expectedWranglerBin());
  });

  it("supports a string-valued package bin", () => {
    writeWranglerPackage("bin/wrangler.js");
    expect(resolveWranglerBin(tmpDir)).toBe(expectedWranglerBin());
  });

  it("walks up to a hoisted workspace node_modules", () => {
    mkdir(tmpDir, "apps/web");
    writeWranglerPackage();
    expect(resolveWranglerBin(path.join(tmpDir, "apps", "web"))).toBe(expectedWranglerBin());
  });

  it("supports package resolvers such as Yarn Plug'n'Play", () => {
    writeWranglerPackage();
    const packageJsonPath = path.join(tmpDir, "node_modules", "wrangler", "package.json");
    expect(resolveWranglerBin("/virtual/project", () => packageJsonPath)).toBe(
      path.join(tmpDir, "node_modules", "wrangler", "bin", "wrangler.js"),
    );
  });

  it("returns a clear fallback path when Wrangler is missing", () => {
    expect(resolveWranglerBin(tmpDir)).toBe(
      path.join(tmpDir, "node_modules", "wrangler", "bin", "wrangler.js"),
    );
  });

  it("passes deploy arguments literally to Node without a command shell", () => {
    writeWranglerPackage();
    expect(buildWranglerInvocation(tmpDir, { env: "preview-1" }, "node.exe")).toEqual({
      file: "node.exe",
      args: [expectedWranglerBin(), "deploy", "--env", "preview-1"],
      env: "preview-1",
    });
  });

  it("keeps Windows shell metacharacters in one literal argument", () => {
    const payload = "preview & whoami > vinext-pwned.txt & rem";
    expect(buildNodeCliInvocation("wrangler.js", ["deploy", "--env", payload], "node.exe")).toEqual(
      {
        file: "node.exe",
        args: ["wrangler.js", "deploy", "--env", payload],
      },
    );
  });

  it("executes Wrangler with shell disabled and literal metacharacters", () => {
    writeWranglerPackage();
    const payload = "preview & whoami > vinext-pwned.txt & rem";
    let observed: Parameters<typeof execFileSync> | undefined;
    const execute = ((...args: Parameters<typeof execFileSync>) => {
      observed = args;
      return "";
    }) as typeof execFileSync;

    runWranglerDeploy(tmpDir, { env: payload }, execute);

    expect(observed?.[0]).toBe(process.execPath);
    expect(observed?.[1]).toEqual([expectedWranglerBin(), "deploy", "--env", payload]);
    expect(observed?.[2]).toMatchObject({ shell: false });
  });

  it("does not execute metacharacters in a real subprocess", () => {
    const argvPath = path.join(tmpDir, "argv.json");
    const pwnedPath = path.join(tmpDir, "vinext-pwned.txt");
    const scriptPath = path.join(tmpDir, "capture-argv.cjs");
    const payload = `preview & echo pwned > ${pwnedPath} & rem`;
    writeFile(
      tmpDir,
      "capture-argv.cjs",
      `require("node:fs").writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))`,
    );
    const invocation = buildNodeCliInvocation(scriptPath, ["deploy", "--env", payload]);

    execFileSync(invocation.file, invocation.args, { cwd: tmpDir, shell: false });

    expect(JSON.parse(fs.readFileSync(argvPath, "utf-8"))).toEqual(["deploy", "--env", payload]);
    expect(fs.existsSync(pwnedPath)).toBe(false);
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
      "--tpr-coverage",
      "95",
      "--tpr-limit",
      "500",
      "--tpr-window",
      "48",
    ]);
    expect(parsed.experimentalTPR).toBe(true);
    expect(parsed.tprCoverage).toBe(95);
    expect(parsed.tprLimit).toBe(500);
    expect(parsed.tprWindow).toBe(48);
  });

  it("parses --prerender-concurrency with space-separated value", () => {
    expect(parseDeployArgs(["--prerender-concurrency", "4"]).prerenderConcurrency).toBe(4);
  });

  it("parses --prerender-concurrency=value form", () => {
    expect(parseDeployArgs(["--prerender-concurrency=4"]).prerenderConcurrency).toBe(4);
  });

  it("throws for missing --prerender-concurrency value", () => {
    expect(() => parseDeployArgs(["--prerender-concurrency"])).toThrow();
  });

  it("throws for invalid --prerender-concurrency value", () => {
    expect(() => parseDeployArgs(["--prerender-concurrency", "abc"])).toThrow(
      '--prerender-concurrency expects a positive integer, but got "abc".',
    );
  });

  it("throws for zero --prerender-concurrency value", () => {
    expect(() => parseDeployArgs(["--prerender-concurrency=0"])).toThrow(
      '--prerender-concurrency expects a positive integer, but got "0".',
    );
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
    expect(info.projectName).toBe("my-app-v2");
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
    expect(parsed.assets).toEqual({
      directory: "dist/client",
      not_found_handling: "none",
      binding: "ASSETS",
    });
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
    writeFile(
      tmpDir,
      "app/page.tsx",
      "export const revalidate = 30;\nexport default function() { return <div/> }",
    );
    const info = detectProject(tmpDir);
    const config = generateWranglerConfig(info);
    const parsed = JSON.parse(config);

    expect(parsed.kv_namespaces).toBeDefined();
    expect(parsed.kv_namespaces[0].binding).toBe("VINEXT_KV_CACHE");
  });

  it("omits KV namespace when no ISR", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/page.tsx", "export default function() { return <div/> }");
    const info = detectProject(tmpDir);
    const config = generateWranglerConfig(info);
    const parsed = JSON.parse(config);

    expect(parsed.kv_namespaces).toBeUndefined();
  });

  it("includes assets.directory pointing to dist/client (required by wrangler 4.69+)", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    const config = generateWranglerConfig(info);
    const parsed = JSON.parse(config);

    // Wrangler 4.69+ rejects assets blocks that lack `directory`.
    // The @cloudflare/vite-plugin always writes static assets to dist/client/.
    expect(parsed.assets.directory).toBe("dist/client");
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
    expect(content).toContain("async fetch(request: Request, env: Env, ctx: ExecutionContext)");
    expect(content).toContain("Promise<Response>");
  });

  it("includes image optimization handler", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("isImageOptimizationPath");
    expect(content).toContain("handleImageOptimization");
  });

  it("declares Env interface with IMAGES binding", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("interface Env");
    expect(content).toContain("IMAGES");
    expect(content).toContain("ASSETS");
  });

  it("declares ExecutionContext interface", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("interface ExecutionContext");
    expect(content).toContain("waitUntil");
  });

  it("passes image handlers inline to handleImageOptimization", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("fetchAsset:");
    expect(content).toContain("transformImage:");
    expect(content).toContain("env.ASSETS.fetch");
    expect(content).toContain("env.IMAGES");
  });

  it("never wires a cache handler into the Worker entry", () => {
    // Cache backends are configured declaratively via vinext({ cache }) in
    // vite.config; the Worker entry must not scaffold setDataCacheHandler.
    const content = generateAppRouterWorkerEntry();
    expect(content).not.toContain("KVCacheHandler");
    expect(content).not.toContain("setDataCacheHandler");
    expect(content).not.toContain("setCdnCacheAdapter");
    expect(content).not.toContain("VINEXT_KV_CACHE");
  });

  it("points users to the declarative cache config", () => {
    const content = generateAppRouterWorkerEntry();
    expect(content).toContain("vinext({ cache })");
  });
});

describe("viteConfigHasCacheAdapter", () => {
  it("detects a data field assigned an adapter", () => {
    writeFile(
      tmpDir,
      "vite.config.ts",
      `import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
       export default { plugins: [vinext({ cache: { data: kvDataAdapter() } })] };`,
    );
    expect(viteConfigHasCacheAdapter(tmpDir)).toBe(true);
  });

  it("detects a cdn field assigned an adapter", () => {
    writeFile(
      tmpDir,
      "vite.config.ts",
      `export default { plugins: [vinext({ cache: { cdn: cdnAdapter() } })] };`,
    );
    expect(viteConfigHasCacheAdapter(tmpDir)).toBe(true);
  });

  it("detects a hand-written descriptor object on the data field", () => {
    writeFile(
      tmpDir,
      "vite.config.ts",
      `export default {
         plugins: [vinext({ cache: { data: { adapter: "./x.js", options: {} } } })],
       };`,
    );
    expect(viteConfigHasCacheAdapter(tmpDir)).toBe(true);
  });

  it("returns false when the cache object is empty", () => {
    writeFile(tmpDir, "vite.config.ts", `export default { plugins: [vinext({ cache: {} })] };`);
    expect(viteConfigHasCacheAdapter(tmpDir)).toBe(false);
  });

  it("returns false when cdn/data are explicitly undefined", () => {
    writeFile(
      tmpDir,
      "vite.config.ts",
      `export default { plugins: [vinext({ cache: { cdn: undefined, data: undefined } })] };`,
    );
    expect(viteConfigHasCacheAdapter(tmpDir)).toBe(false);
  });

  it("returns false when there is no cache config at all", () => {
    writeFile(tmpDir, "vite.config.ts", `export default { plugins: [vinext()] };`);
    expect(viteConfigHasCacheAdapter(tmpDir)).toBe(false);
  });

  it("returns true (does not block) when there is no Vite config to inspect", () => {
    expect(viteConfigHasCacheAdapter(tmpDir)).toBe(true);
  });
});

describe("workerEntryHasCacheHandler", () => {
  it("detects a setCacheHandler call in worker/index.ts", () => {
    writeFile(
      tmpDir,
      "worker/index.ts",
      `import { setCacheHandler } from "vinext/shims/cache";
       setCacheHandler(new KVCacheHandler(env.VINEXT_KV_CACHE));`,
    );
    expect(workerEntryHasCacheHandler(tmpDir)).toBe(true);
  });

  it("detects a setDataCacheHandler call", () => {
    writeFile(
      tmpDir,
      "worker/index.ts",
      `import { setDataCacheHandler } from "vinext/shims/cache";
       setDataCacheHandler(handler);`,
    );
    expect(workerEntryHasCacheHandler(tmpDir)).toBe(true);
  });

  it("detects a setCdnCacheAdapter call", () => {
    writeFile(
      tmpDir,
      "worker/index.ts",
      `import { setCdnCacheAdapter } from "vinext/shims/cdn-cache";
       setCdnCacheAdapter(adapter);`,
    );
    expect(workerEntryHasCacheHandler(tmpDir)).toBe(true);
  });

  it("detects a setter in worker/index.js", () => {
    writeFile(
      tmpDir,
      "worker/index.js",
      `setCacheHandler(new KVCacheHandler(env.VINEXT_KV_CACHE));`,
    );
    expect(workerEntryHasCacheHandler(tmpDir)).toBe(true);
  });

  it("returns false when the Worker entry has no cache setter", () => {
    writeFile(tmpDir, "worker/index.ts", `export default { fetch() {} };`);
    expect(workerEntryHasCacheHandler(tmpDir)).toBe(false);
  });

  it("returns false when there is no Worker entry to inspect", () => {
    expect(workerEntryHasCacheHandler(tmpDir)).toBe(false);
  });
});

describe("formatMissingCacheAdapterError", () => {
  it("names the data adapter builder and the KV namespace command", () => {
    const msg = formatMissingCacheAdapterError({});
    expect(msg).toContain("no cache adapter is configured");
    expect(msg).toContain("kvDataAdapter()");
    expect(msg).toContain("npx wrangler kv namespace create VINEXT_KV_CACHE");
  });

  it("no longer references the cdn adapter", () => {
    const msg = formatMissingCacheAdapterError({});
    expect(msg).not.toContain("cdnAdapter");
    expect(msg).not.toContain("cdn-adapter");
  });
});

describe("scanPublicFileRoutes", () => {
  it("rescans public files on each call instead of returning stale cached results", () => {
    mkdir(tmpDir, "public");
    writeFile(tmpDir, "public/first.txt", "one");

    expect(scanPublicFileRoutes(tmpDir)).toEqual(["/first.txt"]);

    writeFile(tmpDir, "public/nested/second.txt", "two");

    expect(scanPublicFileRoutes(tmpDir)).toEqual(["/first.txt", "/nested/second.txt"]);
  });
});

describe("generatePagesRouterWorkerEntry", () => {
  it("generates valid TypeScript", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("export default");
    expect(content).toContain("async fetch(request: Request, env: Env, ctx: ExecutionContext)");
    expect(content).toContain("Promise<Response>");
  });

  it("runs middleware before routing", () => {
    const content = generatePagesRouterWorkerEntry();
    // Ordering is now enforced by runPagesRequest (the pipeline owner).
    // The worker entry wraps runMiddleware via the shared
    // wrapMiddlewareWithBasePath helper to re-add the basePath before
    // handing the request to the middleware function, then delegates via
    // runPagesRequest.
    expect(content).toContain('typeof runMiddleware === "function"');
    expect(content).toContain("wrapMiddlewareWithBasePath(runMiddleware, basePath, hadBasePath)");
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("applies next.config.js redirects before middleware", () => {
    const content = generatePagesRouterWorkerEntry();
    // Ordering is now enforced by runPagesRequest. The worker passes
    // configRedirects as a dep and delegates to the pipeline owner.
    expect(content).toContain("configRedirects,");
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("handles middleware redirects", () => {
    const content = generatePagesRouterWorkerEntry();
    // Middleware redirect handling is now inside runPagesRequest.
    // The worker entry supplies a wrapped runMiddleware dep and checks result.type.
    expect(content).toContain('typeof runMiddleware === "function"');
    expect(content).toContain('result.type === "response"');
  });

  it("preserves responseHeaders on middleware redirect", () => {
    const content = generatePagesRouterWorkerEntry();
    // responseHeaders handling is now inside runPagesRequest.
    // Verify the worker passes a wrapped runMiddleware dep (which carries responseHeaders).
    expect(content).toContain('typeof runMiddleware === "function"');
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("handles middleware rewrites", () => {
    const content = generatePagesRouterWorkerEntry();
    // Middleware rewrite handling is now inside runPagesRequest.
    // The worker entry supplies a wrapped runMiddleware dep and gets a {type:"response"} result.
    expect(content).toContain('typeof runMiddleware === "function"');
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  // Ported from Next.js: test/e2e/middleware-rewrites/test/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-rewrites/test/index.test.ts
  it("proxies external middleware rewrites before local route handling", () => {
    const content = generatePagesRouterWorkerEntry();
    // External proxy for middleware rewrites is now inside runPagesRequest.
    // The worker entry supplies a wrapped runMiddleware dep and delegates to the pipeline.
    expect(content).toContain('typeof runMiddleware === "function"');
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("handles middleware access control responses", () => {
    const content = generatePagesRouterWorkerEntry();
    // Access control (continue=false) is now inside runPagesRequest.
    // Worker supplies a wrapped runMiddleware dep.
    expect(content).toContain('typeof runMiddleware === "function"');
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("applies next.config.js redirects", () => {
    const content = generatePagesRouterWorkerEntry();
    // Redirect matching is now inside runPagesRequest.
    // Worker passes configRedirects and i18nConfig deps.
    expect(content).toContain("configRedirects,");
    expect(content).toContain("i18nConfig,");
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("applies next.config.js rewrites (beforeFiles, afterFiles, fallback)", () => {
    const content = generatePagesRouterWorkerEntry();
    // Rewrite handling is now inside runPagesRequest.
    // Worker passes configRewrites dep with all three phases.
    expect(content).toContain("configRewrites,");
    expect(content).toContain(
      'matchPageRoute: typeof matchPageRoute === "function" ? matchPageRoute : null',
    );
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("applies next.config.js custom headers", () => {
    const content = generatePagesRouterWorkerEntry();
    // Config header application is now inside runPagesRequest.
    // Worker passes configHeaders dep.
    expect(content).toContain("configHeaders,");
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("handles basePath stripping and creates a new request with stripped URL for middleware", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("basePath");
    expect(content).toContain(
      'import { hasBasePath, stripBasePath } from "vinext/utils/base-path"',
    );
    expect(content).toContain("const stripped = stripBasePath(pathname, basePath);");
    // After stripping, a new request with the stripped URL must be created
    // in the adapter so runPagesRequest receives a clean basePath-free request.
    expect(content).toContain("strippedUrl.pathname = stripped");
    expect(content).toContain("new Request(strippedUrl, request)");
  });

  it("handles trailing slash normalization", () => {
    const content = generatePagesRouterWorkerEntry();
    // Trailing slash normalization is now inside runPagesRequest.
    // Worker passes trailingSlash dep.
    expect(content).toContain("trailingSlash,");
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("routes /api/ to handleApiRoute using resolved URL and forwards ctx", () => {
    const content = generatePagesRouterWorkerEntry();
    // API routing (including locale prefix stripping) is now inside runPagesRequest.
    // Worker supplies handleApi dep that wraps handleApiRoute with ctx.
    // Locale stripping, /api/ prefix check, and ctx forwarding are all inside the owner.
    expect(content).toContain('handleApi: typeof handleApiRoute === "function"');
    expect(content).toContain("handleApiRoute(req, apiUrl, ctx)");
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("includes error handling", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("catch (error)");
    expect(content).toContain("Internal Server Error");
  });

  it("includes image optimization handler", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("isImageOptimizationPath");
    expect(content).toContain("handleImageOptimization");
  });

  it("declares Env interface with IMAGES binding", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("interface Env");
    expect(content).toContain("IMAGES");
    expect(content).toContain("ASSETS");
  });

  it("includes an open-redirect guard that rejects encoded backslash and slash", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("isOpenRedirectShaped");
    expect(content).toContain('from "vinext/server/request-pipeline"');
    expect(content).toContain("isOpenRedirectShaped(pathname)");
  });

  it("passes image handlers inline to handleImageOptimization", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain("fetchAsset:");
    expect(content).toContain("transformImage:");
    expect(content).toContain("env.ASSETS.fetch");
    expect(content).toContain("env.IMAGES");
  });

  it("exports every vinext subpath imported by generated worker entries", () => {
    const exportsMap = readVinextPackageExports();
    const generatedImports = [
      ...extractVinextImportSubpaths(generateAppRouterWorkerEntry()),
      ...extractVinextImportSubpaths(generatePagesRouterWorkerEntry()),
    ];
    const uniqueGeneratedImports = [...new Set(generatedImports)].sort();

    expect(uniqueGeneratedImports.length).toBeGreaterThan(0);
    expect(
      uniqueGeneratedImports.filter((subpath) => !hasPackageExport(exportsMap, subpath)),
    ).toEqual([]);
  });

  it("merges middleware and config headers into responses with correct precedence", () => {
    const content = generatePagesRouterWorkerEntry();
    // mergeHeaders is now called inside runPagesRequest.
    // The worker returns result.response directly from the pipeline result.
    expect(content).toContain("runPagesRequest(request, deps)");
    expect(content).toContain('result.type === "response"');
    expect(content).toContain("return result.response");
  });

  it("mergeHeaders preserves multiple Set-Cookie headers from both middleware and response", () => {
    const response = new Response("body", {
      headers: [
        ["set-cookie", "resp=1; Path=/"],
        ["set-cookie", "resp=2; Path=/"],
        ["content-type", "text/html"],
      ],
    });
    const extraHeaders: Record<string, string | string[]> = {
      "set-cookie": ["mw=1; Path=/"],
      "x-custom": "from-middleware",
    };

    const merged = mergeHeaders(response, extraHeaders);
    const cookies = merged.headers.getSetCookie();
    expect(cookies).toContain("mw=1; Path=/");
    expect(cookies).toContain("resp=1; Path=/");
    expect(cookies).toContain("resp=2; Path=/");
    // Response takes precedence for non-Set-Cookie headers
    expect(merged.headers.get("content-type")).toBe("text/html");
    // Middleware-only headers are preserved
    expect(merged.headers.get("x-custom")).toBe("from-middleware");
  });

  it("mergeHeaders drops the body for no-body middleware rewrite statuses", async () => {
    for (const status of [204, 205, 304]) {
      const response = new Response("body", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "4" },
      });

      const merged = mergeHeaders(response, { "x-custom": "from-middleware" }, status);

      expect(merged.status).toBe(status);
      expect(merged.headers.get("x-custom")).toBe("from-middleware");
      expect(merged.headers.get("content-type")).toBeNull();
      expect(merged.headers.get("content-length")).toBeNull();
      expect(await merged.text()).toBe("");
    }
  });

  it("mergeHeaders cancels discarded body streams for no-body statuses", async () => {
    let started = false;
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          started = true;
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (canceled) return;
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
        cancel() {
          canceled = true;
        },
      }),
      {
        headers: {
          "content-type": "text/plain",
          "content-length": "5",
        },
      },
    );

    const merged = mergeHeaders(response, { "x-custom": "from-middleware" }, 204);

    expect(merged.status).toBe(204);
    expect(merged.headers.get("content-type")).toBeNull();
    expect(merged.headers.get("content-length")).toBeNull();
    expect(await merged.text()).toBe("");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(true);
    expect(canceled).toBe(true);
  });

  it("mergeHeaders strips stale content-length only for tagged streamed Pages HTML", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": "1",
        },
      },
    ) as Response & { __vinextStreamedHtmlResponse?: boolean };
    response.__vinextStreamedHtmlResponse = true;

    const merged = mergeHeaders(response, { "x-custom": "from-middleware" });

    expect(merged.headers.get("content-length")).toBeNull();
    expect(merged.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(merged.headers.get("x-custom")).toBe("from-middleware");
    expect(await merged.text()).toBe("hello");
  });

  it("mergeHeaders strips middleware-provided content-length for untagged responses", async () => {
    const response = new Response("body", {
      status: 200,
      headers: {
        "content-type": "text/plain",
      },
    });

    const merged = mergeHeaders(response, {
      "content-length": "1",
      "x-custom": "from-middleware",
    });

    expect(merged.headers.get("content-length")).toBeNull();
    expect(merged.headers.get("content-type")).toBe("text/plain");
    expect(merged.headers.get("x-custom")).toBe("from-middleware");
    expect(await merged.text()).toBe("body");
  });

  it("mergeHeaders preserves response content-length over middleware content-length for untagged custom responses", async () => {
    const response = new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "3",
      },
    });

    const merged = mergeHeaders(response, {
      "content-length": "1",
      "x-custom": "from-middleware",
    });

    expect(merged.headers.get("content-length")).toBe("3");
    expect(merged.headers.get("content-type")).toBe("application/octet-stream");
    expect(merged.headers.get("x-custom")).toBe("from-middleware");
    const body = Buffer.from(await merged.arrayBuffer());
    expect(body.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("generated worker entry includes the no-body and streamed content-length merge guards", () => {
    const content = generatePagesRouterWorkerEntry();
    // mergeHeaders (including no-body and streamed content-length guards) is
    // now called inside runPagesRequest. The worker delegates to the pipeline.
    expect(content).toContain("runPagesRequest(request, deps)");
    expect(content).toContain('result.type === "response"');
    expect(content).toContain("return result.response");
  });

  it("resolveStaticAssetSignal fetches and merges static asset responses with middleware status", async () => {
    const signalResponse = new Response(null, {
      status: 403,
      headers: [
        ["x-vinext-static-file", encodeURIComponent("/logo/logo.svg")],
        ["x-middleware", "blocked"],
        ["content-type", "text/plain"],
      ],
    });

    const resolved = await resolveStaticAssetSignal(signalResponse, {
      fetchAsset: async (path) =>
        new Response("<svg />", {
          status: 200,
          headers: {
            "content-type": "image/svg+xml",
            "cache-control": "public, max-age=3600",
            "x-asset-path": path,
          },
        }),
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe(403);
    expect(resolved!.headers.get("content-type")).toBe("image/svg+xml");
    expect(resolved!.headers.get("x-middleware")).toBe("blocked");
    expect(resolved!.headers.get("x-asset-path")).toBe("/logo/logo.svg");
    expect(await resolved!.text()).toBe("<svg />");
  });

  it("preserves x-middleware-request-* headers for prod request override handling", () => {
    const content = generatePagesRouterWorkerEntry();
    // applyMiddlewareRequestHeaders is now called inside runPagesRequest.
    // The worker entry delegates to the pipeline owner via runPagesRequest.
    expect(content).toContain("runPagesRequest(request, deps)");
    expect(content).toContain('typeof runMiddleware === "function"');
  });

  it("handles external rewrites via proxyExternalRequest", () => {
    const content = generatePagesRouterWorkerEntry();
    // External rewrite proxying is now inside runPagesRequest.
    // The worker entry delegates to the pipeline owner.
    expect(content).toContain("runPagesRequest(request, deps)");
    expect(content).toContain("configRewrites,");
  });

  it("guards renderPage with typeof check", () => {
    const content = generatePagesRouterWorkerEntry();
    // The typeof guard is now in the adapter deps wiring.
    expect(content).toContain('typeof renderPage === "function"');
  });

  it("does not defer error page rendering for data requests", () => {
    const content = generatePagesRouterWorkerEntry();
    // shouldDeferErrorPageOnMiss logic is now inside runPagesRequest.
    // The worker passes isDataReq: false (no buildId normalization) and
    // matchPageRoute dep so the pipeline computes the right behavior.
    expect(content).toContain("isDataReq: false,");
    expect(content).toContain(
      'matchPageRoute: typeof matchPageRoute === "function" ? matchPageRoute : null',
    );
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("builds reqCtx before middleware runs", () => {
    const content = generatePagesRouterWorkerEntry();
    // reqCtx is now built inside runPagesRequest before middleware.
    // The worker passes configRedirects and a wrapped runMiddleware dep; ordering is
    // guaranteed by the pipeline owner.
    expect(content).toContain("configRedirects,");
    expect(content).toContain('typeof runMiddleware === "function"');
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  it("checks image optimization after basePath stripping", () => {
    const content = generatePagesRouterWorkerEntry();
    const basePathPos = content.indexOf("const stripped = stripBasePath(pathname, basePath);");
    const imagePos = content.indexOf("isImageOptimizationPath(pathname)");
    expect(basePathPos).toBeGreaterThan(-1);
    expect(imagePos).toBeGreaterThan(-1);
    expect(basePathPos).toBeLessThan(imagePos);
  });

  it("uses segment-boundary check before skipping redirect destination prefixing", () => {
    const content = generatePagesRouterWorkerEntry();
    // Segment-boundary checks for redirect destination prefixing are now
    // inside runPagesRequest. The worker passes hadBasePath and basePath deps.
    expect(content).toContain("hadBasePath,");
    expect(content).toContain("basePath,");
    expect(content).toContain("runPagesRequest(request, deps)");
  });

  // Regression for #1337: invalid `_next/static/*` paths must short-circuit
  // with a plain-text 404 instead of falling through to renderPage (which
  // would render the full HTML 404 page with bootstrap scripts + CSS).
  // Matches Next.js: packages/next/src/server/lib/router-server.ts.
  it("short-circuits invalid `_next/static/*` paths with plain-text 404", () => {
    const content = generatePagesRouterWorkerEntry();
    expect(content).toContain(
      'import { notFoundStaticAssetResponse } from "vinext/server/http-error-responses"',
    );
    expect(content).toContain(
      'import { assetPrefixPathname, isNextStaticPath } from "vinext/utils/asset-prefix"',
    );
    expect(content).toContain("assetPrefixPathname(vinextConfig?.assetPrefix");
    expect(content).toContain("isNextStaticPath(pathname, basePath, assetPathPrefix)");
    expect(content).toContain("return notFoundStaticAssetResponse();");

    // The short-circuit must fire BEFORE runPagesRequest (which invokes renderPage)
    // so the rich HTML 404 is never rendered for asset misses.
    const staticPos = content.indexOf("isNextStaticPath(pathname, basePath, assetPathPrefix)");
    const pipelinePos = content.indexOf("runPagesRequest(request, deps)");
    expect(staticPos).toBeGreaterThan(-1);
    expect(pipelinePos).toBeGreaterThan(staticPos);
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
  it("reports missing @vitejs/plugin-react", () => {
    mkdir(tmpDir, "pages");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;

    const notResolvable = () => false;
    const missing = getMissingDeps(info, notResolvable);
    expect(missing).toContainEqual(expect.objectContaining({ name: "@vitejs/plugin-react" }));
  });

  it("reports missing @cloudflare/vite-plugin", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = false;
    info.hasWrangler = true;
    info.hasRscPlugin = true;

    const missing = getMissingDeps(info);
    expect(missing).toContainEqual(expect.objectContaining({ name: "@cloudflare/vite-plugin" }));
  });

  it("reports missing wrangler", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = false;
    info.hasRscPlugin = true;

    const missing = getMissingDeps(info);
    expect(missing).toContainEqual(expect.objectContaining({ name: "wrangler" }));
  });

  it("reports missing @vitejs/plugin-rsc for App Router", () => {
    mkdir(tmpDir, "app");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = false;

    const missing = getMissingDeps(info);
    expect(missing).toContainEqual(expect.objectContaining({ name: "@vitejs/plugin-rsc" }));
  });

  it("does not require @vitejs/plugin-rsc for Pages Router", () => {
    mkdir(tmpDir, "pages");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = false;

    const missing = getMissingDeps(info);
    expect(missing).not.toContainEqual(expect.objectContaining({ name: "@vitejs/plugin-rsc" }));
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
    expect(missing).toContainEqual(expect.objectContaining({ name: "react-server-dom-webpack" }));
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

// ─── viteConfigHasCloudflarePlugin ───────────────────────────────────────────

describe("viteConfigHasCloudflarePlugin", () => {
  it("returns true when vite.config.ts imports @cloudflare/vite-plugin", () => {
    writeFile(
      tmpDir,
      "vite.config.ts",
      `
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [cloudflare()] });
`,
    );
    expect(viteConfigHasCloudflarePlugin(tmpDir)).toBe(true);
  });

  it("returns true for App Router config with viteEnvironment", () => {
    writeFile(
      tmpDir,
      "vite.config.ts",
      `
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
export default defineConfig({
  plugins: [vinext(), cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })],
});
`,
    );
    expect(viteConfigHasCloudflarePlugin(tmpDir)).toBe(true);
  });

  it("returns false when vite.config.ts does not import @cloudflare/vite-plugin", () => {
    writeFile(
      tmpDir,
      "vite.config.ts",
      `
import vinext from "vinext";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [vinext()] });
`,
    );
    expect(viteConfigHasCloudflarePlugin(tmpDir)).toBe(false);
  });

  it("returns false for the minimal config generated by vinext init", () => {
    // init generates a local-dev-only config without the cloudflare plugin
    writeFile(
      tmpDir,
      "vite.config.ts",
      `import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext()],
});
`,
    );
    expect(viteConfigHasCloudflarePlugin(tmpDir)).toBe(false);
  });

  it("returns true for vite.config.js", () => {
    writeFile(
      tmpDir,
      "vite.config.js",
      `
import { cloudflare } from "@cloudflare/vite-plugin";
export default { plugins: [cloudflare()] };
`,
    );
    expect(viteConfigHasCloudflarePlugin(tmpDir)).toBe(true);
  });

  it("returns true for vite.config.mjs", () => {
    writeFile(
      tmpDir,
      "vite.config.mjs",
      `
import { cloudflare } from "@cloudflare/vite-plugin";
export default { plugins: [cloudflare()] };
`,
    );
    expect(viteConfigHasCloudflarePlugin(tmpDir)).toBe(true);
  });

  it("returns false when no vite config file exists", () => {
    // tmpDir has no vite config
    expect(viteConfigHasCloudflarePlugin(tmpDir)).toBe(false);
  });
});

// ─── hasWranglerConfig ───────────────────────────────────────────────────────

describe("hasWranglerConfig", () => {
  it("returns true when wrangler.jsonc exists", () => {
    writeFile(tmpDir, "wrangler.jsonc", "{}");
    expect(hasWranglerConfig(tmpDir)).toBe(true);
  });

  it("returns true when wrangler.json exists", () => {
    writeFile(tmpDir, "wrangler.json", "{}");
    expect(hasWranglerConfig(tmpDir)).toBe(true);
  });

  it("returns true when wrangler.toml exists", () => {
    writeFile(tmpDir, "wrangler.toml", "");
    expect(hasWranglerConfig(tmpDir)).toBe(true);
  });

  it("returns false when none exist", () => {
    expect(hasWranglerConfig(tmpDir)).toBe(false);
  });
});

// ─── formatMissingCloudflarePluginError ─────────────────────────────────────

describe("formatMissingCloudflarePluginError", () => {
  it("includes viteEnvironment config when isAppRouter is true", () => {
    const msg = formatMissingCloudflarePluginError({ isAppRouter: true });
    expect(msg).toContain("viteEnvironment");
    expect(msg).toContain('childEnvironments: ["ssr"]');
  });

  it("omits viteEnvironment config when isAppRouter is false", () => {
    const msg = formatMissingCloudflarePluginError({ isAppRouter: false });
    expect(msg).not.toContain("viteEnvironment");
  });

  it("includes actual config file path when configFile is provided", () => {
    const msg = formatMissingCloudflarePluginError({
      isAppRouter: false,
      configFile: "/project/vite.config.mts",
    });
    expect(msg).toContain("/project/vite.config.mts");
  });

  it("uses generic 'your Vite config' when configFile is undefined", () => {
    const msg = formatMissingCloudflarePluginError({ isAppRouter: false });
    expect(msg).toContain("your Vite config");
  });

  it("never hardcodes vite.config.ts when no configFile given", () => {
    const msg = formatMissingCloudflarePluginError({ isAppRouter: false });
    expect(msg).not.toMatch(/vite\.config\.ts/);
    expect(msg).not.toMatch(/vite\.config\.js/);
    expect(msg).not.toMatch(/vite\.config\.mjs/);
  });

  it("always starts with the [vinext] prefix", () => {
    const msg = formatMissingCloudflarePluginError({ isAppRouter: false });
    expect(msg).toMatch(/^\[vinext\] Missing @cloudflare\/vite-plugin/);
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
    writeFile(
      tmpDir,
      "tailwind.config.js",
      `const plugin = require("tailwindcss/plugin");\nmodule.exports = {};`,
    );

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
    writeFile(
      tmpDir,
      "src/app/page.tsx",
      "export default function Home() { return <div>hi</div> }",
    );
    const info = detectProject(tmpDir);
    expect(info.isAppRouter).toBe(true);
    expect(info.isPagesRouter).toBe(false);
  });

  it("detects Pages Router when only src/pages/ exists", () => {
    mkdir(tmpDir, "src/pages");
    writeFile(
      tmpDir,
      "src/pages/index.tsx",
      "export default function Home() { return <div>hi</div> }",
    );
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
    writeFile(
      tmpDir,
      "src/app/page.tsx",
      "export default function Home() { return <div>hi</div> }",
    );
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
    writeFile(
      tmpDir,
      "src/app/page.tsx",
      "export default function Home() { return <div>hi</div> }",
    );
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
    writeFile(
      tmpDir,
      "src/pages/index.tsx",
      "export default function Home() { return <div>hi</div> }",
    );
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

  it("detects native modules listed only in devDependencies", () => {
    mkdir(tmpDir, "app");
    writeFile(
      tmpDir,
      "package.json",
      JSON.stringify({ devDependencies: { sharp: "^0.33.0", lightningcss: "^1.0.0" } }),
    );
    const info = detectProject(tmpDir);
    expect(info.nativeModulesToStub).toContain("sharp");
    expect(info.nativeModulesToStub).toContain("lightningcss");
  });

  it("nativeModulesToStub is empty when no native deps", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    const info = detectProject(tmpDir);
    expect(info.nativeModulesToStub).toEqual([]);
  });

  it("detects ISR and MDX from a single app/ tree walk", () => {
    // ISR (`export const revalidate`) and a `.mdx` file live in the same tree;
    // detection shares one recursive walk and reports both.
    mkdir(tmpDir, "app");
    writeFile(
      tmpDir,
      "app/posts/page.tsx",
      "export const revalidate = 60;\nexport default function() { return <div/> }",
    );
    writeFile(tmpDir, "app/about/page.mdx", "# About");
    const info = detectProject(tmpDir);
    expect(info.hasISR).toBe(true);
    expect(info.hasMDX).toBe(true);
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
    const missing = getMissingDeps(info, (root, pkg) => pkg !== "@mdx-js/rollup");
    expect(missing).toContainEqual(expect.objectContaining({ name: "@mdx-js/rollup" }));
  });

  it("does not report @mdx-js/rollup when it is resolvable", () => {
    mkdir(tmpDir, "app");
    writeFile(tmpDir, "app/about/page.mdx", "# About");
    const info = detectProject(tmpDir);
    info.hasCloudflarePlugin = true;
    info.hasWrangler = true;
    info.hasRscPlugin = true;

    const missing = getMissingDeps(info, () => true);
    expect(missing).not.toContainEqual(expect.objectContaining({ name: "@mdx-js/rollup" }));
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
  function generateHeaders(clientDir: string, assetsDir = "_next/static"): void {
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
    expect(content).toContain("/_next/static/*");
    expect(content).toContain("Cache-Control: public, max-age=31536000, immutable");
    // Verify Cloudflare _headers format: path on its own line, indented header below
    const lines = content.split("\n");
    const pathLine = lines.findIndex((l) => l === "/_next/static/*");
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
    expect(content).not.toContain("/_next/static/*");
  });

  it("respects custom assetsDir", () => {
    const clientDir = path.join(tmpDir, "dist", "client");
    fs.mkdirSync(clientDir, { recursive: true });

    generateHeaders(clientDir, "static");

    const content = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(content).toContain("/static/*");
    expect(content).not.toContain("/_next/static/*");
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
   * Replicates the closeBundle hook logic for App Router builds. Mirrors the
   * REAL wiring in index.ts: it forwards the same `includeClientEntry` ternary
   * and serializes globals via the shared `buildRuntimeGlobalsScript` helper, so
   * the simulator cannot drift from production. `hasPagesDir` exercises the
   * mixed app+pages branch (where the Pages client entry IS injected).
   */
  function simulateCloseBundleAppRouter(
    buildRoot: string,
    base = "/",
    assetPrefix = "",
    hasPagesDir = false,
  ): void {
    const distDir = path.resolve(buildRoot, "dist");
    if (!fs.existsSync(distDir)) return;

    const clientDir = path.resolve(buildRoot, "dist", "client");

    const runtimeMetadata = computeClientRuntimeMetadata({
      clientDir,
      assetBase: base,
      assetPrefix,
      // index.ts: `!hasAppDir ? true : hasPagesDir ? "pages-client-entry" : false`
      includeClientEntry: hasPagesDir ? "pages-client-entry" : false,
    });

    // Read SSR manifest
    let ssrManifestData: Record<string, string[]> | null = null;
    const ssrManifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
    if (fs.existsSync(ssrManifestPath)) {
      try {
        ssrManifestData = JSON.parse(fs.readFileSync(ssrManifestPath, "utf-8"));
      } catch {
        /* ignore */
      }
    }

    const workerEntry = path.resolve(distDir, "server", "index.js");
    if (!fs.existsSync(workerEntry)) return;
    const script = buildRuntimeGlobalsScript({
      clientEntryFile: runtimeMetadata.clientEntryFile,
      ssrManifest: ssrManifestData,
      lazyChunks: runtimeMetadata.lazyChunks,
      dynamicPreloads: runtimeMetadata.dynamicPreloads,
    });
    if (script) {
      const code = fs.readFileSync(workerEntry, "utf-8");
      fs.writeFileSync(workerEntry, script + "\n" + code);
    }
  }

  /**
   * Replicates the closeBundle hook logic for Pages Router builds. Mirrors the
   * real index.ts wiring and serializes via the shared helper.
   */
  function simulateCloseBundlePagesRouter(buildRoot: string, base = "/", assetPrefix = ""): void {
    const distDir = path.resolve(buildRoot, "dist");
    if (!fs.existsSync(distDir)) return;

    const clientDir = path.resolve(buildRoot, "dist", "client");

    const runtimeMetadata = computeClientRuntimeMetadata({
      clientDir,
      assetBase: base,
      assetPrefix,
      includeClientEntry: true,
    });

    // Find worker output directory (contains wrangler.json)
    let workerOutDir: string | null = null;
    for (const entry of fs.readdirSync(distDir)) {
      const candidate = path.join(distDir, entry);
      if (entry === "client") continue;
      if (
        fs.statSync(candidate).isDirectory() &&
        fs.existsSync(path.join(candidate, "wrangler.json"))
      ) {
        workerOutDir = candidate;
        break;
      }
    }
    if (!workerOutDir) return;

    const workerEntry = path.join(workerOutDir, "index.js");
    if (!fs.existsSync(workerEntry)) return;

    // Read SSR manifest
    let ssrManifestData: Record<string, string[]> | null = null;
    const ssrManifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
    if (fs.existsSync(ssrManifestPath)) {
      try {
        ssrManifestData = JSON.parse(fs.readFileSync(ssrManifestPath, "utf-8"));
      } catch {
        /* ignore */
      }
    }

    const script = buildRuntimeGlobalsScript({
      clientEntryFile: runtimeMetadata.clientEntryFile,
      ssrManifest: ssrManifestData,
      lazyChunks: runtimeMetadata.lazyChunks,
      dynamicPreloads: runtimeMetadata.dynamicPreloads,
    });
    if (script) {
      const code = fs.readFileSync(workerEntry, "utf-8");
      fs.writeFileSync(workerEntry, script + "\n" + code);
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

  it("App Router: injects __VINEXT_DYNAMIC_PRELOADS__ into dist/server/index.js", () => {
    setupAppRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundleAppRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");
    expect(code).toContain("globalThis.__VINEXT_DYNAMIC_PRELOADS__");
    expect(code).toContain(
      `"src/components/MermaidChart.tsx":["assets/mermaid-chart.js","assets/mermaid-vendor.js"]`,
    );
    expect(code).not.toContain(`"virtual:vinext-app-browser-entry"`);
  });

  it("App Router: lazy chunks stay base-relative while only dynamic preloads take the assetPrefix", () => {
    setupAppRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundleAppRouter(tmpDir, "/docs/", "/cdn-prefix");

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");
    const lazyMatch = code.match(/globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*(\[.*?\]);/);
    expect(lazyMatch).not.toBeNull();
    const lazyChunks = JSON.parse(lazyMatch![1]);
    // Lazy chunks must stay in the SSR-manifest key-space (basePath only) so the
    // Pages Router modulepreload-exclusion membership test still matches.
    expect(lazyChunks).toContain("docs/assets/mermaid-chart.js");
    expect(lazyChunks).toContain("docs/assets/mermaid-vendor.js");
    expect(lazyChunks).not.toContain("cdn-prefix/_next/static/assets/mermaid-chart.js");

    // Dynamic preloads render real <link> hrefs, so they DO take the assetPrefix.
    const preloadMatch = code.match(/globalThis\.__VINEXT_DYNAMIC_PRELOADS__\s*=\s*(\{.*?\});/);
    expect(preloadMatch).not.toBeNull();
    const dynamicPreloads = JSON.parse(preloadMatch![1]);
    expect(dynamicPreloads["src/components/MermaidChart.tsx"]).toEqual([
      "cdn-prefix/_next/static/assets/mermaid-chart.js",
      "cdn-prefix/_next/static/assets/mermaid-vendor.js",
    ]);
  });

  it("App Router: never emits an absolute-URL assetPrefix into lazy chunks (regression: modulepreload leak)", () => {
    setupAppRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundleAppRouter(tmpDir, "/docs/", "https://cdn.example.com/assets");

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");

    // Dynamic preloads get the absolute URL...
    expect(code).toContain("https://cdn.example.com/assets/_next/static/assets/mermaid-chart.js");

    // ...but lazy chunks MUST stay base-relative. An absolute URL here would
    // never match the base-relative SSR-manifest values, so the Pages Router
    // would fail to exclude lazy chunks and leak them into <link rel=modulepreload>.
    const lazyMatch = code.match(/globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*(\[.*?\]);/);
    expect(lazyMatch).not.toBeNull();
    const lazyChunks = JSON.parse(lazyMatch![1]) as string[];
    expect(lazyChunks).toEqual(["docs/assets/mermaid-chart.js", "docs/assets/mermaid-vendor.js"]);
    expect(lazyChunks.some((c) => c.startsWith("https://"))).toBe(false);
  });

  it("App Router (mixed app+pages): injects __VINEXT_CLIENT_ENTRY__ for the Pages fallback entry", () => {
    setupAppRouterBuildOutput(tmpDir, manifestWithLazyChunks);
    // A real mixed app+pages build emits a Pages client entry chunk. Place one
    // on disk so the (recursive) on-disk fallback resolves it under chunks/.
    const chunksDir = path.join(tmpDir, "dist", "client", "_next", "static", "chunks");
    fs.mkdirSync(chunksDir, { recursive: true });
    fs.writeFileSync(path.join(chunksDir, "vinext-client-entry-abcd.js"), "");

    // hasPagesDir = true → includeClientEntry: "pages-client-entry"
    simulateCloseBundleAppRouter(tmpDir, "/", "", true);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");
    expect(code).toContain(
      'globalThis.__VINEXT_CLIENT_ENTRY__ = "_next/static/chunks/vinext-client-entry-abcd.js";',
    );
  });

  it("App Router: dynamic preloads avoid double-prefixing a realistic (already-prefixed) manifest", () => {
    // A real assetPrefix build bakes the prefix into the manifest `file` fields
    // (build.assetsDir = `<prefix>/_next/static`). Both lazy chunks and dynamic
    // preloads must then resolve to the SAME single-prefixed URL.
    const prefixedManifest = {
      "virtual:vinext-app-browser-entry": {
        file: "cdn/_next/static/chunks/app-entry-abc.js",
        isEntry: true,
        imports: ["node_modules/react/index.js"],
        dynamicImports: ["src/components/MermaidChart.tsx"],
      },
      "node_modules/react/index.js": { file: "cdn/_next/static/chunks/framework-def.js" },
      "src/components/MermaidChart.tsx": {
        file: "cdn/_next/static/chunks/mermaid-chart-ghi.js",
        isDynamicEntry: true,
      },
    };
    setupAppRouterBuildOutput(tmpDir, prefixedManifest);

    simulateCloseBundleAppRouter(tmpDir, "/", "/cdn");

    const code = fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf-8");
    const lazyMatch = code.match(/globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*(\[.*?\]);/);
    const lazyChunks = JSON.parse(lazyMatch![1]) as string[];
    expect(lazyChunks).toEqual(["cdn/_next/static/chunks/mermaid-chart-ghi.js"]);
    // No `cdn/_next/static/cdn/...` double prefix.
    expect(code).not.toContain("cdn/_next/static/cdn/");
    expect(code).toContain(
      `"src/components/MermaidChart.tsx":["cdn/_next/static/chunks/mermaid-chart-ghi.js"]`,
    );
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
    // No globals should be injected since there are no lazy chunks, no dynamic
    // preload entries, and no SSR manifest
    expect(code).not.toContain("globalThis.__VINEXT_LAZY_CHUNKS__");
    expect(code).not.toContain("globalThis.__VINEXT_DYNAMIC_PRELOADS__");
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

  it("Pages Router: injects all runtime globals into worker entry", () => {
    const ssrManifest = {
      "pages/index.tsx": ["/assets/page-index.js", "/assets/page-index.css"],
    };
    setupPagesRouterBuildOutput(tmpDir, manifestWithLazyChunks, ssrManifest);

    simulateCloseBundlePagesRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "worker", "index.js"), "utf-8");
    expect(code).toContain("globalThis.__VINEXT_CLIENT_ENTRY__");
    expect(code).toContain("globalThis.__VINEXT_SSR_MANIFEST__");
    expect(code).toContain("globalThis.__VINEXT_LAZY_CHUNKS__");
    expect(code).toContain("globalThis.__VINEXT_DYNAMIC_PRELOADS__");
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

  it("Pages Router: injects __VINEXT_DYNAMIC_PRELOADS__ into worker entry", () => {
    setupPagesRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundlePagesRouter(tmpDir);

    const code = fs.readFileSync(path.join(tmpDir, "dist", "worker", "index.js"), "utf-8");
    expect(code).toContain("globalThis.__VINEXT_DYNAMIC_PRELOADS__");
    expect(code).toContain(
      `"src/components/MermaidChart.tsx":["assets/mermaid-chart.js","assets/mermaid-vendor.js"]`,
    );
  });

  it("Pages Router: prefixes client entry and lazy chunks with basePath", () => {
    setupPagesRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundlePagesRouter(tmpDir, "/docs/");

    const code = fs.readFileSync(path.join(tmpDir, "dist", "worker", "index.js"), "utf-8");
    expect(code).toContain('globalThis.__VINEXT_CLIENT_ENTRY__ = "docs/assets/app-entry.js";');

    const match = code.match(/globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*(\[.*?\]);/);
    expect(match).not.toBeNull();
    const lazyChunks = JSON.parse(match![1]);
    expect(lazyChunks).toContain("docs/assets/mermaid-chart.js");
    expect(lazyChunks).toContain("docs/assets/mermaid-vendor.js");
    expect(code).toContain(
      `"src/components/MermaidChart.tsx":["docs/assets/mermaid-chart.js","docs/assets/mermaid-vendor.js"]`,
    );
  });

  it("Pages Router: lazy chunks stay base-relative while only dynamic preloads take the assetPrefix", () => {
    setupPagesRouterBuildOutput(tmpDir, manifestWithLazyChunks);

    simulateCloseBundlePagesRouter(tmpDir, "/docs/", "/cdn-prefix");

    const code = fs.readFileSync(path.join(tmpDir, "dist", "worker", "index.js"), "utf-8");
    const lazyMatch = code.match(/globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*(\[.*?\]);/);
    expect(lazyMatch).not.toBeNull();
    const lazyChunks = JSON.parse(lazyMatch![1]);
    // Pages Router is the actual consumer: lazy chunks MUST stay base-relative so
    // collectAssetTags' modulepreload-exclusion membership test matches.
    expect(lazyChunks).toContain("docs/assets/mermaid-chart.js");
    expect(lazyChunks).toContain("docs/assets/mermaid-vendor.js");
    expect(lazyChunks).not.toContain("cdn-prefix/_next/static/assets/mermaid-chart.js");
    // Dynamic preloads still take the assetPrefix.
    expect(code).toContain(
      `"src/components/MermaidChart.tsx":["cdn-prefix/_next/static/assets/mermaid-chart.js","cdn-prefix/_next/static/assets/mermaid-vendor.js"]`,
    );
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
    fs.writeFileSync(path.join(workerDir, "index.js"), "// unmodified");
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

// ─── detectPackageManager ────────────────────────────────────────────────────

describe("detectPackageManager", () => {
  it("detects pnpm from pnpm-lock.yaml", () => {
    writeFile(tmpDir, "pnpm-lock.yaml", "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm add -D");
    expect(detectPackageManagerName(tmpDir)).toBe("pnpm");
  });

  it("detects yarn from yarn.lock", () => {
    writeFile(tmpDir, "yarn.lock", "");
    expect(detectPackageManager(tmpDir)).toBe("yarn add -D");
    expect(detectPackageManagerName(tmpDir)).toBe("yarn");
  });

  it("detects bun from bun.lock (text format, Bun v1.0+)", () => {
    writeFile(tmpDir, "bun.lock", "");
    expect(detectPackageManager(tmpDir)).toBe("bun add -D");
    expect(detectPackageManagerName(tmpDir)).toBe("bun");
  });

  it("detects bun from bun.lockb (legacy binary format)", () => {
    writeFile(tmpDir, "bun.lockb", "");
    expect(detectPackageManager(tmpDir)).toBe("bun add -D");
    expect(detectPackageManagerName(tmpDir)).toBe("bun");
  });

  it("falls back to npm when no lock file is found", () => {
    // Clear the user-agent env var so the CI runner's package manager (pnpm)
    // doesn't leak into the fallback chain.
    const savedUA = process.env.npm_config_user_agent;
    delete process.env.npm_config_user_agent;
    try {
      expect(detectPackageManager(tmpDir)).toBe("npm install -D");
      expect(detectPackageManagerName(tmpDir)).toBe("npm");
    } finally {
      if (savedUA !== undefined) process.env.npm_config_user_agent = savedUA;
    }
  });

  it("walks up to parent directory to find lock file (monorepo root)", () => {
    writeFile(tmpDir, "bun.lock", "");
    const appDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(appDir, { recursive: true });
    writeFile(appDir, "package.json", JSON.stringify({ name: "web" }));

    expect(detectPackageManager(appDir)).toBe("bun add -D");
    expect(detectPackageManagerName(appDir)).toBe("bun");
  });

  it("prefers the closest lock file when both child and parent have one", () => {
    writeFile(tmpDir, "bun.lock", "");
    const appDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(appDir, { recursive: true });
    writeFile(appDir, "pnpm-lock.yaml", "");

    expect(detectPackageManager(appDir)).toBe("pnpm add -D");
    expect(detectPackageManagerName(appDir)).toBe("pnpm");
  });
});

// ─── findInNodeModules ───────────────────────────────────────────────────────

describe("findInNodeModules", () => {
  it("finds a package in the immediate node_modules", () => {
    mkdir(tmpDir, "node_modules/@cloudflare/vite-plugin");
    const result = findInNodeModules(tmpDir, "@cloudflare/vite-plugin");
    expect(result).toBe(path.join(tmpDir, "node_modules", "@cloudflare", "vite-plugin"));
  });

  it("finds a binary in node_modules/.bin", () => {
    writeFile(tmpDir, "node_modules/.bin/wrangler", "#!/usr/bin/env node");
    const result = findInNodeModules(tmpDir, ".bin/wrangler");
    expect(result).toBe(path.join(tmpDir, "node_modules", ".bin", "wrangler"));
  });

  it("returns null when not found anywhere", () => {
    expect(findInNodeModules(tmpDir, ".bin/wrangler")).toBeNull();
  });

  it("walks up to find package in monorepo root node_modules", () => {
    writeFile(tmpDir, "node_modules/.bin/wrangler", "#!/usr/bin/env node");
    const appDir = path.join(tmpDir, "apps", "web-next");
    fs.mkdirSync(appDir, { recursive: true });

    const result = findInNodeModules(appDir, ".bin/wrangler");
    expect(result).toBe(path.join(tmpDir, "node_modules", ".bin", "wrangler"));
  });

  it("prefers the closest node_modules when both app and root have the package", () => {
    mkdir(tmpDir, "node_modules/@cloudflare/vite-plugin");
    const appDir = path.join(tmpDir, "apps", "web-next");
    mkdir(appDir, "node_modules/@cloudflare/vite-plugin");

    const result = findInNodeModules(appDir, "@cloudflare/vite-plugin");
    expect(result).toBe(path.join(appDir, "node_modules", "@cloudflare", "vite-plugin"));
  });
});

// ─── ESM config compatibility (issue #184) ──────────────────────────────────
//
// Tests for ensureViteConfigCompatibility() — the wrapper in utils/project.ts
// that renames CJS configs + adds type:module before Vite loads the config.
//
// The underlying ensureESModule() and renameCJSConfigs() are tested above.
// These tests cover the wrapper's own guards and the integration of both
// functions together.

describe("ensureViteConfigCompatibility — issue #184", () => {
  it("renames CJS configs and adds type:module when vite.config.ts exists", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "web", version: "1.0.0" }));
    writeFile(
      tmpDir,
      "vite.config.ts",
      'import { cloudflare } from "@cloudflare/vite-plugin";\nexport default { plugins: [cloudflare()] };',
    );
    writeFile(
      tmpDir,
      "postcss.config.js",
      "module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };",
    );

    const result = ensureViteConfigCompatibility(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.addedTypeModule).toBe(true);
    expect(result!.renamed).toEqual([["postcss.config.js", "postcss.config.cjs"]]);

    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.type).toBe("module");
    expect(fs.existsSync(path.join(tmpDir, "postcss.config.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "postcss.config.js"))).toBe(false);
  });

  it("returns null when no vite.config exists", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "web", version: "1.0.0" }));

    const result = ensureViteConfigCompatibility(tmpDir);
    expect(result).toBeNull();

    // package.json should not be modified
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.type).toBeUndefined();
  });

  it("returns null when package.json already has type:module", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "web", type: "module" }));
    writeFile(tmpDir, "vite.config.ts", "export default {};");

    const result = ensureViteConfigCompatibility(tmpDir);
    expect(result).toBeNull();
  });

  it("does not override explicit 'type': 'commonjs'", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "web", type: "commonjs" }));
    writeFile(tmpDir, "vite.config.ts", "export default {};");
    writeFile(tmpDir, "postcss.config.js", "module.exports = {};");

    const result = ensureViteConfigCompatibility(tmpDir);
    expect(result).toBeNull();

    // package.json should not be modified
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.type).toBe("commonjs");

    // CJS configs should not be renamed either
    expect(fs.existsSync(path.join(tmpDir, "postcss.config.js"))).toBe(true);
  });

  it("returns null when no package.json exists", () => {
    writeFile(tmpDir, "vite.config.ts", "export default {};");

    const result = ensureViteConfigCompatibility(tmpDir);
    expect(result).toBeNull();
  });

  it("detects vite.config.js (not only .ts)", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "web", version: "1.0.0" }));
    writeFile(tmpDir, "vite.config.js", "export default {};");

    const result = ensureViteConfigCompatibility(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.addedTypeModule).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.type).toBe("module");
  });

  it("handles a workspaces monorepo: only updates the leaf package.json", () => {
    const webDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(webDir, { recursive: true });

    // Root package.json (CJS)
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "monorepo", workspaces: ["apps/*"] }));
    // Workspace package.json (no type:module)
    writeFile(webDir, "package.json", JSON.stringify({ name: "web", version: "1.0.0" }));
    writeFile(webDir, "vite.config.ts", "export default {};");

    const result = ensureViteConfigCompatibility(webDir);

    expect(result).not.toBeNull();
    expect(result!.addedTypeModule).toBe(true);

    const rootPkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    const webPkg = JSON.parse(fs.readFileSync(path.join(webDir, "package.json"), "utf-8"));

    // Only the workspace package should be modified
    expect(webPkg.type).toBe("module");
    expect(rootPkg.type).toBeUndefined();
  });
});

// ─── domainCandidates ────────────────────────────────────────────────────────

describe("domainCandidates", () => {
  it("returns a single candidate for a bare domain", () => {
    expect(domainCandidates("example.com")).toEqual(["example.com"]);
  });

  it("starts from the shortest suffix for a simple subdomain", () => {
    expect(domainCandidates("shop.example.com")).toEqual(["example.com", "shop.example.com"]);
  });

  it("handles multi-part TLDs by trying progressively longer candidates", () => {
    expect(domainCandidates("shop.example.co.uk")).toEqual([
      "co.uk",
      "example.co.uk",
      "shop.example.co.uk",
    ]);
  });

  it("handles deeply nested subdomains", () => {
    expect(domainCandidates("a.b.c.example.com")).toEqual([
      "example.com",
      "c.example.com",
      "b.c.example.com",
      "a.b.c.example.com",
    ]);
  });
});

// ─── parseWranglerConfig — TPR fields ────────────────────────────────────────

describe("parseWranglerConfig — custom domain extraction", () => {
  it("extracts custom domain from routes array (string form)", () => {
    writeFile(tmpDir, "wrangler.jsonc", JSON.stringify({ routes: ["example.co.uk/*"] }));
    const config = parseWranglerConfig(tmpDir);
    expect(config?.customDomain).toBe("example.co.uk");
  });

  it("extracts custom domain from custom_domains array", () => {
    writeFile(tmpDir, "wrangler.json", JSON.stringify({ custom_domains: ["shop.example.com.au"] }));
    const config = parseWranglerConfig(tmpDir);
    expect(config?.customDomain).toBe("shop.example.com.au");
  });

  it("ignores workers.dev domains", () => {
    writeFile(tmpDir, "wrangler.json", JSON.stringify({ routes: ["my-app.workers.dev/*"] }));
    const config = parseWranglerConfig(tmpDir);
    expect(config?.customDomain).toBeUndefined();
  });

  it("extracts KV namespace ID for VINEXT_KV_CACHE", () => {
    writeFile(
      tmpDir,
      "wrangler.json",
      JSON.stringify({
        kv_namespaces: [{ binding: "VINEXT_KV_CACHE", id: "abc123" }],
      }),
    );
    const config = parseWranglerConfig(tmpDir);
    expect(config?.kvNamespaceId).toBe("abc123");
  });
});
