import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

// Published vinext resolves to emitted JS, which the dev RSC environment loads
// natively instead of transforming it through Vite. Source checkouts resolve to
// TypeScript and are never externalized, so this must run against the dist build.
const VINEXT_ENTRY_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js");
const VINEXT_ENTRY_URL = pathToFileURL(VINEXT_ENTRY_PATH).href;
const roots: string[] = [];

function createAppProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dev-externals-"));
  roots.push(root);
  // Externalized handlers resolve by package name from the project root, like a
  // real app with vinext installed. The workspace fixture's node_modules links
  // vinext to this checkout.
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
    "export default function Page() { return <main>external handler</main>; }\n",
  );
  fs.writeFileSync(
    path.join(root, "probe.mjs"),
    `import { createServer } from "vite";
import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
const server = await createServer({
  root: ${JSON.stringify(root)},
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  configFile: false,
  logLevel: "silent",
  plugins: [vinext()],
  server: { host: "127.0.0.1", port: 0 },
});
try {
  await server.listen();
  const { port } = server.httpServer.address();
  const response = await fetch(\`http://127.0.0.1:\${port}/\`);
  const body = await response.text();
  const ids = [...server.environments.rsc.moduleGraph.idToModuleMap.keys()];
  console.log("probe:" + JSON.stringify({ status: response.status, body, ids }));
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

describe("App Router dev externals", () => {
  it("loads the combined RSC handler outside Vite's RSC module graph", async () => {
    if (!fs.existsSync(VINEXT_ENTRY_PATH)) {
      throw new Error("Build vinext first: vp run vinext#build");
    }
    const root = createAppProject();
    const child = spawn(process.execPath, ["probe.mjs"], { cwd: root, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
    const status = await new Promise<number | null>((resolve) => child.once("close", resolve));
    clearTimeout(timer);
    expect(status, stderr).toBe(0);
    const line = stdout.split("\n").find((candidate) => candidate.startsWith("probe:"));
    expect(line, stdout).toBeDefined();
    const probe = JSON.parse(line!.slice("probe:".length)) as {
      status: number;
      body: string;
      ids: string[];
    };

    expect(probe.status).toBe(200);
    expect(probe.body).toContain("external handler");
    expect(probe.ids.some((id) => id.includes("virtual:vinext-rsc-entry"))).toBe(true);
    expect(probe.ids.filter((id) => /[/\\]app-rsc-(?:combined-)?handler\.js$/.test(id))).toEqual(
      [],
    );
  }, 60_000);
});
