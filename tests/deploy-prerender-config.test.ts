import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";

const runPrerenderMock = vi.hoisted(() => vi.fn(async () => ({ routes: [] })));

vi.mock("vinext/internal/build/run-prerender", () => ({
  runPrerender: runPrerenderMock,
}));

vi.mock("vinext/internal/utils/project", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/vinext/src/utils/project.js")>();
  return {
    ...actual,
    getMissingDeps: vi.fn(() => []),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      const childStdout = new PassThrough();
      child.stdout = childStdout;
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        childStdout.write("Published app\n  https://app.example.workers.dev\n");
        child.emit("close", 0, null);
      });
      return child;
    }),
  };
});

let tmpDir: string;

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function createMockChildProcess(output: string, code: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const childStdout = new PassThrough();
  child.stdout = childStdout;
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    if (output) childStdout.write(output);
    child.emit("close", code, null);
  });
  return child;
}

function writeProject(prerenderConfig: string, cacheConfig?: string): void {
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
      ...(cacheConfig
        ? ['import { kvDataAdapter } from "../packages/cloudflare/src/cache/kv-data-adapter";']
        : []),
      "",
      "export default defineConfig({",
      `  plugins: [vinext({ prerender: ${prerenderConfig}${cacheConfig ? `, cache: ${cacheConfig}` : ""} }), cloudflare()],`,
      "});",
      "",
    ].join("\n"),
  );
}

function writeProjectWithThrowingViteConfig(): void {
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
  writeFile("throws-on-load.js", 'throw new Error("vite config loaded unexpectedly");\n');
  writeFile(
    "vite.config.ts",
    [
      'import "./throws-on-load.js";',
      'import { cloudflare } from "@cloudflare/vite-plugin";',
      'import vinext from "../packages/vinext/src/index";',
      "",
      "export default {",
      "  plugins: [vinext(), cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })],",
      "};",
      "",
    ].join("\n"),
  );
}

describe("deploy prerender config wiring", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-vinext-deploy-prerender-"));
    runPrerenderMock.mockClear();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs prerender during deploy when vinext config uses the true shorthand", async () => {
    writeProject("true");
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    expect(runPrerenderMock).toHaveBeenCalledWith({ root: tmpDir, concurrency: undefined });
    expect(
      vi.mocked(spawn).mock.calls.some(([, args]) => {
        const wranglerArgs = args as string[];
        return wranglerArgs.includes("kv") && wranglerArgs.includes("bulk");
      }),
    ).toBe(false);
  });

  it("runs prerender during deploy when vinext config uses routes star", async () => {
    writeProject('{ routes: "*" }');
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    expect(runPrerenderMock).toHaveBeenCalledWith({ root: tmpDir, concurrency: undefined });
  });

  it("passes deploy prerender concurrency through config-triggered prerender", async () => {
    writeProject('{ routes: "*" }');
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, prerenderConcurrency: 3 });

    expect(runPrerenderMock).toHaveBeenCalledWith({ root: tmpDir, concurrency: 3 });
  });

  it("does not load Vite config when the prerender-all flag already wins", async () => {
    writeProjectWithThrowingViteConfig();
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, prerenderAll: true });

    expect(runPrerenderMock).toHaveBeenCalledWith({ root: tmpDir, concurrency: undefined });
  });

  it("does not load Vite config when static export already wins", async () => {
    writeProjectWithThrowingViteConfig();
    writeFile("next.config.mjs", 'export default { output: "export" };\n');
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    expect(runPrerenderMock).toHaveBeenCalledWith({ root: tmpDir, concurrency: undefined });
  });

  it("uploads prerendered App Router artifacts to KV only when configured in Vite", async () => {
    writeProject('{ routes: "*" }', '{ data: kvDataAdapter({ binding: "MY_KV" }) }');
    runPrerenderMock.mockImplementationOnce(async () => {
      writeFile(
        "dist/server/vinext-prerender.json",
        JSON.stringify({
          buildId: "build-1",
          routes: [{ route: "/about", status: "rendered", revalidate: 60, router: "app" }],
        }),
      );
      writeFile("dist/server/prerendered-routes/about.html", "<html>About</html>");
      writeFile("dist/server/prerendered-routes/about.rsc", "flight");
      return { routes: [] };
    });
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    const calls = vi.mocked(spawn).mock.calls;
    const kvBulkCall = calls.find(([, args]) => {
      const wranglerArgs = args as string[];
      return wranglerArgs.includes("kv") && wranglerArgs.includes("bulk");
    });
    expect(kvBulkCall?.[1]).toEqual([
      expect.stringContaining("wrangler"),
      "kv",
      "bulk",
      "put",
      expect.stringContaining("prerender-kv-0.json"),
      "--binding",
      "MY_KV",
      "--remote",
    ]);
    expect(calls.at(-1)?.[1]).toEqual([expect.stringContaining("wrangler"), "deploy"]);
  });

  it("continues deploy when configured KV prerender upload fails", async () => {
    writeProject('{ routes: "*" }', '{ data: kvDataAdapter({ binding: "MY_KV" }) }');
    runPrerenderMock.mockImplementationOnce(async () => {
      writeFile(
        "dist/server/vinext-prerender.json",
        JSON.stringify({
          buildId: "build-1",
          routes: [{ route: "/about", status: "rendered", revalidate: 60, router: "app" }],
        }),
      );
      writeFile("dist/server/prerendered-routes/about.html", "<html>About</html>");
      return { routes: [] };
    });
    vi.mocked(spawn).mockImplementation(((_file, args) => {
      const wranglerArgs = args as string[];
      if (wranglerArgs.includes("kv") && wranglerArgs.includes("bulk")) {
        return createMockChildProcess("", 1);
      }
      return createMockChildProcess("Published app\n  https://app.example.workers.dev\n", 0);
    }) as typeof spawn);
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toEqual([
      expect.stringContaining("wrangler"),
      "deploy",
    ]);
  });
});
