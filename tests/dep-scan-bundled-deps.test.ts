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

function runProbe(root: string): Promise<{ errors: string[] }> {
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
});
