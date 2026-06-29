import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";

const runPrerenderMock = vi.hoisted(() => vi.fn(async () => ({ routes: [] })));

vi.mock("../packages/vinext/src/build/run-prerender.js", () => ({
  runPrerender: runPrerenderMock,
}));

vi.mock("../packages/vinext/src/cloudflare/project.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/vinext/src/cloudflare/project.js")>();
  return {
    ...actual,
    getMissingDeps: vi.fn(() => []),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(() => "Published app\n  https://app.example.workers.dev\n"),
  };
});

let tmpDir: string;

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function writeProject(prerenderConfig: string): void {
  writeFile("package.json", JSON.stringify({ name: "prerender-config-app", type: "module" }));
  writeFile("app/page.tsx", "export default function Page() { return <div>home</div>; }\n");
  writeFile(
    "node_modules/@cloudflare/vite-plugin/package.json",
    JSON.stringify({ name: "@cloudflare/vite-plugin", type: "module", main: "index.js" }),
  );
  writeFile(
    "node_modules/@cloudflare/vite-plugin/index.js",
    "export function cloudflare() { return { name: 'test-cloudflare-plugin' }; }\n",
  );
  writeFile(
    "wrangler.jsonc",
    '{"main":"vinext/server/app-router-entry","assets":{"directory":"dist/client"}}\n',
  );
  writeFile(
    "vite.config.ts",
    [
      'import { defineConfig } from "vite";',
      'import { cloudflare } from "@cloudflare/vite-plugin";',
      'import vinext from "../packages/vinext/src/index";',
      "",
      "export default defineConfig({",
      `  plugins: [vinext({ prerender: ${prerenderConfig} }), cloudflare()],`,
      "});",
      "",
    ].join("\n"),
  );
}

describe("deploy prerender config wiring", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-vinext-deploy-prerender-"));
    runPrerenderMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs prerender during deploy when vinext config uses the true shorthand", async () => {
    writeProject("true");
    const { deploy } = await import("../packages/vinext/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    expect(runPrerenderMock).toHaveBeenCalledWith({ root: tmpDir, concurrency: undefined });
  });

  it("runs prerender during deploy when vinext config uses routes star", async () => {
    writeProject('{ routes: "*" }');
    const { deploy } = await import("../packages/vinext/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    expect(runPrerenderMock).toHaveBeenCalledWith({ root: tmpDir, concurrency: undefined });
  });

  it("passes deploy prerender concurrency through config-triggered prerender", async () => {
    writeProject('{ routes: "*" }');
    const { deploy } = await import("../packages/vinext/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, prerenderConcurrency: 3 });

    expect(runPrerenderMock).toHaveBeenCalledWith({ root: tmpDir, concurrency: 3 });
  });
});
