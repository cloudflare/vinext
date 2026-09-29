import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

// Published vinext resolves to emitted JS, which the dev RSC environment loads
// natively instead of transforming it through Vite. Source checkouts resolve to
// TypeScript and are never externalized, so this must run against the dist build.
const VINEXT_ENTRY_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js"),
).href;
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
  console.log(JSON.stringify({ status: response.status, body, ids }));
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
  it("loads the combined RSC handler outside Vite's RSC module graph", () => {
    const root = createAppProject();
    const result = spawnSync(process.execPath, ["probe.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const probe = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
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
