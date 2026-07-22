import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

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
    execFileSync: vi.fn((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({ versions: [] });
      }
      if (args.includes("deploy")) {
        return "Deployed version\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    }),
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

function writeProjectWithInlineNextConfig(nextConfig: string): void {
  writeFile("package.json", JSON.stringify({ name: "inline-next-config-app", type: "module" }));
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
      'import { cloudflare } from "@cloudflare/vite-plugin";',
      'import vinext from "../packages/vinext/src/index";',
      "",
      `export default { plugins: [vinext({ nextConfig: ${nextConfig} }), cloudflare()] };`,
      "",
    ].join("\n"),
  );
}

function writeApiOnlyProject(): void {
  writeFile("package.json", JSON.stringify({ name: "warm-skip-build-app", type: "module" }));
  writeFile(
    "app/api/health/route.ts",
    "export function GET() { return Response.json({ ok: true }); }\n",
  );
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
      "  plugins: [vinext(), cloudflare()],",
      "});",
      "",
    ].join("\n"),
  );
  writeFile("dist/server/BUILD_ID", "build-a\n");
  writeFile("dist/server/index.js", "export default {};\n");
}

describe("deploy prerender config wiring", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-vinext-deploy-prerender-"));
    runPrerenderMock.mockClear();
    vi.mocked(execFileSync).mockClear();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs prerender during deploy when vinext config uses the true shorthand", async () => {
    writeProject("true");
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    expect(runPrerenderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: tmpDir,
        concurrency: undefined,
        nextConfig: expect.any(Object),
      }),
    );
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

    expect(runPrerenderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: tmpDir,
        concurrency: undefined,
        nextConfig: expect.any(Object),
      }),
    );
  });

  it("loads Vite config even when the prerender-all flag already decides prerendering", async () => {
    writeProject("true");
    fs.appendFileSync(
      path.join(tmpDir, "vite.config.ts"),
      '\nthrow new Error("vite config loaded");\n',
    );
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await expect(deploy({ root: tmpDir, skipBuild: true, prerenderAll: true })).rejects.toThrow(
      "vite config loaded",
    );
  });

  it("loads Vite config even when disk config already enables static export", async () => {
    writeProject("true");
    writeFile("next.config.mjs", 'export default { output: "export" };\n');
    fs.appendFileSync(
      path.join(tmpDir, "vite.config.ts"),
      '\nthrow new Error("vite config loaded");\n',
    );
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await expect(deploy({ root: tmpDir, skipBuild: true })).rejects.toThrow("vite config loaded");
  });

  it("loads Vite config once for all deploy metadata", async () => {
    writeProject("true", '{ data: kvDataAdapter({ binding: "MY_KV" }) }');
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    runPrerenderMock.mockImplementationOnce(async () => {
      writeFile(
        "dist/server/vinext-prerender.json",
        JSON.stringify({
          buildId: "build-a",
          routes: [{ route: "/about", status: "rendered", revalidate: 60, router: "app" }],
        }),
      );
      writeFile("dist/server/prerendered-routes/about.html", "<html>About</html>");
      writeFile("dist/server/prerendered-routes/about.rsc", "flight");
      return { routes: [] };
    });
    writeFile(
      "count-config-load.js",
      [
        'import fs from "node:fs";',
        'const countPath = new URL("./config-load-count.txt", import.meta.url);',
        'const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;',
        "fs.writeFileSync(countPath, String(count + 1));",
        "",
      ].join("\n"),
    );
    const viteConfigPath = path.join(tmpDir, "vite.config.ts");
    fs.writeFileSync(
      viteConfigPath,
      `import "./count-config-load.js";\n${fs.readFileSync(viteConfigPath, "utf8")}`,
    );
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, warmCdnCache: true });

    expect(fs.readFileSync(path.join(tmpDir, "config-load-count.txt"), "utf8")).toBe("1");
    expect(fs.existsSync(path.join(tmpDir, "dist/server/vinext-prerender-paths.json"))).toBe(true);
    expect(
      vi.mocked(spawn).mock.calls.some(([, args]) => {
        const wranglerArgs = args as string[];
        return wranglerArgs.includes("kv") && wranglerArgs.includes("bulk");
      }),
    ).toBe(true);
  });

  it("runs static export during deploy when output export is configured inline", async () => {
    writeProjectWithInlineNextConfig('{ output: "export" }');
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    expect(runPrerenderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: tmpDir,
        concurrency: undefined,
        nextConfig: expect.objectContaining({ output: "export" }),
      }),
    );
  });

  it("passes deploy prerender concurrency through config-triggered prerender", async () => {
    writeProject('{ routes: "*" }');
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, prerenderConcurrency: 3 });

    expect(runPrerenderMock).toHaveBeenCalledWith(
      expect.objectContaining({ root: tmpDir, concurrency: 3 }),
    );
  });

  it("resolves function-form inline config inside the selected Cloudflare environment", async () => {
    writeProjectWithInlineNextConfig(
      '() => ({ output: process.env.CLOUDFLARE_ENV === "preview" ? "export" : undefined, generateBuildId: () => process.env.CLOUDFLARE_ENV ?? "missing" })',
    );
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, env: "preview" });

    expect(runPrerenderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({ output: "export", buildId: "preview" }),
      }),
    );
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

  it("discovers warmup paths during skip-build warm CDN deploys", async () => {
    writeApiOnlyProject();
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, warmCdnCache: true });

    expect(
      JSON.parse(
        fs.readFileSync(path.join(tmpDir, "dist/server/vinext-prerender-paths.json"), "utf-8"),
      ),
    ).toEqual({
      buildId: "build-a",
      trailingSlash: false,
      paths: [],
    });
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toEqual([
      expect.stringContaining("wrangler"),
      "deploy",
    ]);
  });
});
