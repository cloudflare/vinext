import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

// vinext inlines some dependencies (for example ua-parser-js behind the
// next/server userAgent shim) into dist/deps, already converted to ESM. Source
// checkouts import the original package from node_modules instead, so this
// must run against the dist build.
const VINEXT_ENTRY_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js"),
).href;
const roots: string[] = [];

function createAppProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dep-scan-"));
  roots.push(root);
  // The workspace fixture's node_modules links vinext to this checkout.
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "fixtures/app-basic/node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(root, "app/layout.tsx"),
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  fs.writeFileSync(
    path.join(root, "app/page.tsx"),
    'import { userAgent } from "next/server";\nexport default function Page() { return <main>{typeof userAgent}</main>; }\n',
  );
  fs.writeFileSync(
    path.join(root, "probe.mjs"),
    `import { createLogger, createServer } from "vite";
import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
const errors = [];
const customLogger = createLogger("silent");
customLogger.error = (message) => errors.push(message);
const server = await createServer({
  root: ${JSON.stringify(root)},
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  configFile: false,
  customLogger,
  plugins: [vinext()],
  server: { host: "127.0.0.1", port: 0 },
});
try {
  await server.listen();
  await server.environments.client.depsOptimizer?.scanProcessing;
  console.log("probe:" + JSON.stringify({ errors }));
} finally {
  await server.close();
}
`,
  );
  return root;
}

// Requests the client modules the next/* shims reach inside vinext and reports
// the dependencies Vite discovers on the way. Each one would re-run the
// optimizer and reload the page on the first request that renders it.
function createLinkedVinextProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dep-scan-linked-"));
  roots.push(root);
  // The workspace fixture's node_modules links vinext to this checkout, so its
  // files live outside node_modules.
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "fixtures/app-basic/node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(root, "app/layout.tsx"),
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  fs.writeFileSync(
    path.join(root, "app/page.tsx"),
    'import Link from "next/link";\nexport default function Page() { return <Link href="/">home</Link>; }\n',
  );
  fs.writeFileSync(
    path.join(root, "probe.mjs"),
    `import fs from "node:fs";
import path from "node:path";
import { createLogger, createServer } from "vite";
import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
const vinextDist = ${JSON.stringify(path.resolve(import.meta.dirname, "../packages/vinext/dist"))};
const server = await createServer({
  root: ${JSON.stringify(root)},
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  configFile: false,
  customLogger: createLogger("silent"),
  plugins: [vinext()],
  // A monorepo's workspace root would contain the linked package.
  server: { host: "127.0.0.1", port: 0, fs: { allow: [${JSON.stringify(path.resolve(import.meta.dirname, ".."))}] } },
});
try {
  await server.listen();
  const environment = server.environments.client;
  const optimizer = environment.depsOptimizer;
  await optimizer.scanProcessing;
  const known = new Set([
    ...Object.keys(optimizer.metadata.optimized),
    ...Object.keys(optimizer.metadata.discovered),
  ]);
  const importer = path.join(${JSON.stringify(root)}, "app/page.tsx");
  const queue = [];
  for (const specifier of ${JSON.stringify(LINKED_CLIENT_SHIM_SPECIFIERS)}) {
    const resolved = await environment.pluginContainer.resolveId(specifier, importer);
    // vinext's shim aliases point at extensionless paths.
    if (resolved) queue.push("/@fs" + (fs.existsSync(resolved.id) ? resolved.id : resolved.id + ".js"));
  }
  const seen = new Set(queue);
  while (queue.length > 0) {
    const url = queue.shift();
    await environment.transformRequest(url);
    const node = await environment.moduleGraph.getModuleByUrl(url);
    for (const imported of node?.importedModules ?? []) {
      if (!imported.file?.startsWith(vinextDist + path.sep) || seen.has(imported.url)) continue;
      seen.add(imported.url);
      queue.push(imported.url);
    }
  }
  const discovered = Object.keys(optimizer.metadata.discovered).filter((id) => !known.has(id));
  console.log("probe:" + JSON.stringify({ requested: seen.size, discovered }));
} finally {
  await server.close();
}
`,
  );
  return root;
}

// The client-side next/* entry points an app can import.
const LINKED_CLIENT_SHIM_SPECIFIERS = [
  "next/dynamic",
  "next/form",
  "next/head",
  "next/image",
  "next/legacy/image",
  "next/link",
  "next/navigation",
  "next/router",
  "next/script",
  "next/web-vitals",
];

function runProbe<T = { errors: string[] }>(root: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["probe.mjs"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // Kill a stalled dev server before the test timeout so it cannot outlive
    // the test; the close handler then rejects with its output.
    const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((entry) => entry.startsWith("probe:"));
      if (code !== 0 || !line) {
        reject(new Error(`probe exited with ${code}\n${stdout}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line.slice("probe:".length)));
    });
  });
}

// An installed vinext lives in node_modules, unlike this checkout's workspace
// link, so the optimizer treats the files its next/* aliases resolve to as
// dependencies. Copy the dist build into node_modules to model npm's layout.
function createInstalledVinextProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-installed-optimizer-"));
  roots.push(root);
  const nodeModules = path.join(root, "node_modules");
  const vinextDir = path.join(nodeModules, "vinext");
  const vinextPackage = path.resolve(import.meta.dirname, "../packages/vinext");
  fs.mkdirSync(vinextDir, { recursive: true });
  for (const name of ["dist", "package.json"]) {
    fs.cpSync(path.join(vinextPackage, name), path.join(vinextDir, name), { recursive: true });
  }
  fs.symlinkSync(
    path.join(vinextPackage, "node_modules"),
    path.join(vinextDir, "node_modules"),
    "junction",
  );
  for (const name of ["react", "react-dom", "vite"]) {
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules", name),
      path.join(nodeModules, name),
      "junction",
    );
  }
  // Libraries that import next/* themselves, as ESM and as CommonJS.
  const libraries: Record<string, Record<string, string>> = {
    "esm-nav-lib": {
      "package.json": '{"name":"esm-nav-lib","type":"module","exports":"./index.js"}',
      "index.js": 'export { useRouter as libUseRouter } from "next/navigation.js";',
    },
    "cjs-link-lib": {
      "package.json": '{"name":"cjs-link-lib","main":"index.js"}',
      "index.js": 'const Link = require("next/link"); exports.LibLink = Link.default || Link;',
    },
    "cjs-headers-lib": {
      "package.json": '{"name":"cjs-headers-lib","main":"index.js"}',
      "index.js": 'exports.libHeaders = () => require("next/headers").headers();',
    },
  };
  for (const [name, files] of Object.entries(libraries)) {
    fs.mkdirSync(path.join(nodeModules, name));
    for (const [file, code] of Object.entries(files)) {
      fs.writeFileSync(path.join(nodeModules, name, file), code);
    }
  }
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(root, "app/layout.tsx"),
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  fs.writeFileSync(
    path.join(root, "app/page.tsx"),
    'import Link from "next/link";\nimport { libHeaders } from "cjs-headers-lib";\nimport { Client } from "./client";\nexport default function Page() { return <main><Link href="/">{typeof libHeaders}</Link><Client /></main>; }\n',
  );
  fs.writeFileSync(
    path.join(root, "app/client.tsx"),
    `"use client";
import Form from "next/form";
import Image from "next/image";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { libUseRouter } from "esm-nav-lib";
import { LibLink } from "cjs-link-lib";
export function Client() {
  return <p>{String(libUseRouter === useRouter && LibLink && Form && Image && Script)}</p>;
}
`,
  );
  fs.writeFileSync(
    path.join(root, "probe.mjs"),
    `import fs from "node:fs";
import { createLogger, createServer } from "vite";
import vinext from "vinext";
const server = await createServer({
  root: ${JSON.stringify(root)},
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  configFile: false,
  customLogger: createLogger("silent"),
  plugins: [vinext()],
  // Cloudflare's Worker environments discover dependencies; Node dev does not.
  environments: { rsc: { optimizeDeps: { noDiscovery: false } } },
  // Vite pre-bundles included specifiers even when they are excluded.
  optimizeDeps: { include: ["next/link", "cjs-link-lib > next/link"] },
  server: { host: "127.0.0.1", port: 0 },
});
try {
  await server.listen();
  const optimizer = server.environments.client.depsOptimizer;
  await optimizer.scanProcessing;
  const deps = { ...optimizer.metadata.optimized, ...optimizer.metadata.discovered };
  const libraries = {};
  for (const name of ["esm-nav-lib", "cjs-link-lib"]) {
    await deps[name]?.processing;
    libraries[name] = deps[name] ? fs.readFileSync(deps[name].file, "utf8") : null;
  }
  // Served raw from node_modules, so Vite would not discover its imports.
  const imageConfig = await server.environments.client.transformRequest(
    "/node_modules/vinext/dist/shims/image-config.js",
  );
  const ipaddrImport = imageConfig.code.match(/from "([^"]*ipaddr[^"]*)"/)?.[1] ?? null;
  // Server environments pre-bundle with platform "node" (or "neutral" on
  // Cloudflare), where Vite leaves require() calls to excluded ids as is.
  const rscOptimizer = server.environments.rsc.depsOptimizer;
  await rscOptimizer.scanProcessing;
  const rscDeps = { ...rscOptimizer.metadata.optimized, ...rscOptimizer.metadata.discovered };
  await rscDeps["cjs-headers-lib"]?.processing;
  libraries["cjs-headers-lib"] = rscDeps["cjs-headers-lib"]
    ? fs.readFileSync(rscDeps["cjs-headers-lib"].file, "utf8")
    : null;
  console.log("probe:" + JSON.stringify({ deps: Object.keys(deps), libraries, ipaddrImport }));
} finally {
  await server.close();
}
`,
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("client dependency scan", () => {
  // vite-plugin-commonjs registers a dependency pre-bundle plugin that calls
  // vinext's filter directly. It must leave vinext's inlined dependencies alone,
  // or it appends a second default export and the whole scan fails.
  it("scans an app that imports a shim with an inlined CommonJS dependency", async () => {
    const { errors } = await runProbe(createAppProject());
    expect(errors).toEqual([]);
  }, 60_000);

  // Excluded shims are not crawled by the dependency scan, so their imports
  // must be known at startup or the first request that reaches them reloads.
  it("discovers no dependencies when a linked vinext's client shims are requested", async () => {
    const { requested, discovered } = await runProbe<{ requested: number; discovered: string[] }>(
      createLinkedVinextProject(),
    );
    expect(requested).toBeGreaterThan(10);
    expect(discovered).toEqual([]);
  }, 60_000);

  // A pre-bundled shim carries its own copy of vinext's module state, so
  // <Link> navigations would not reach the app's instrumentation hooks.
  it("keeps an installed vinext's next/* shims out of the dependency optimizers", async () => {
    const { deps, libraries, ipaddrImport } = await runProbe<{
      deps: string[];
      libraries: Record<string, string | null>;
      ipaddrImport: string | null;
    }>(createInstalledVinextProject());
    expect(deps).toEqual(expect.arrayContaining(["esm-nav-lib", "cjs-link-lib"]));
    expect(
      deps.filter((id) => {
        const depId = id.slice(id.lastIndexOf(">") + 1).trim();
        return depId.startsWith("next/") || depId === "vinext" || depId.startsWith("vinext/");
      }),
    ).toEqual([]);
    // Libraries keep their next/* imports bare, which resolve to the same shim
    // module as the app's imports instead of inlining another copy.
    expect(libraries["esm-nav-lib"]).toContain('from "next/navigation.js"');
    expect(libraries["cjs-link-lib"]).toContain('from "next/link"');
    expect(libraries["cjs-headers-lib"]).toContain('from "next/headers"');
    expect(libraries["cjs-headers-lib"]).not.toMatch(/require\(\s*"next\/headers"/);
    for (const code of Object.values(libraries)) {
      expect(code).not.toMatch(/\.\/(?:navigation|link)-[\w-]+\.js/);
    }
    // The raw next/image shim's CommonJS dependency must still be pre-bundled.
    expect(ipaddrImport).toContain("/.vite/deps/");
  }, 60_000);
});
