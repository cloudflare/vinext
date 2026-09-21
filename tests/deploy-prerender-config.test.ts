import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

const runPrerenderMock = vi.hoisted(() => vi.fn(async () => ({ routes: [] })));
const emitPrerenderPathManifestMock = vi.hoisted(() => vi.fn());
const discoverPrerenderPathManifestMock = vi.hoisted(() => vi.fn());
const resolveTPRRoutesMock = vi.hoisted(() =>
  vi.fn(async () => ({ routes: [] as { path: string; requests: number }[] })),
);
const realWranglerUrl = pathToFileURL(
  createRequire(path.join(process.cwd(), "examples/app-router-cloudflare/package.json")).resolve(
    "wrangler",
  ),
).href;

vi.mock("vinext/internal/build/run-prerender", () => ({
  runPrerender: runPrerenderMock,
}));

vi.mock("../packages/cloudflare/src/tpr.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../packages/cloudflare/src/tpr.js")>()),
  resolveTPRRoutes: resolveTPRRoutesMock,
}));

vi.mock("vinext/internal/build/prerender-paths", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/vinext/src/build/prerender-paths.js")>();
  return {
    ...actual,
    discoverPrerenderPathManifest: async (
      options: Parameters<typeof actual.discoverPrerenderPathManifest>[0],
    ) => {
      discoverPrerenderPathManifestMock(options);
      return actual.discoverPrerenderPathManifest(options);
    },
    emitPrerenderPathManifest: async (
      options: Parameters<typeof actual.emitPrerenderPathManifest>[0],
    ) => {
      emitPrerenderPathManifestMock(options);
      return actual.emitPrerenderPathManifest(options);
    },
  };
});

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
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\n  https://app.example.workers.dev\n";
      }
      if (args.includes("deploy")) {
        return "Deployed version\n";
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

function writeProject(prerenderConfig: string | undefined, cacheConfig?: string): void {
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
    '{"name":"test-worker","main":"vinext/server/app-router-entry","assets":{"directory":"dist/client"}}\n',
  );
  writeFile(
    "vite.config.ts",
    [
      'import { defineConfig } from "vite";',
      'import { cloudflare } from "@cloudflare/vite-plugin";',
      'import vinext from "../packages/vinext/src/index";',
      ...(cacheConfig?.includes("kvDataAdapter")
        ? ['import { kvDataAdapter } from "../packages/cloudflare/src/cache/kv-data-adapter";']
        : []),
      ...(cacheConfig?.includes("cdnAdapter")
        ? ['import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter";']
        : []),
      ...(cacheConfig?.includes("staticAssetsAdapter")
        ? [
            'import { staticAssetsAdapter } from "../packages/cloudflare/src/cache/static-assets-adapter";',
          ]
        : []),
      "",
      "export default defineConfig({",
      `  plugins: [vinext({ ${[
        prerenderConfig ? `prerender: ${prerenderConfig}` : null,
        cacheConfig ? `cache: ${cacheConfig}` : null,
      ]
        .filter(Boolean)
        .join(", ")} }), cloudflare()],`,
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
    '{"name":"test-worker","main":"vinext/server/app-router-entry","assets":{"directory":"dist/client"}}\n',
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
    "node_modules/wrangler/package.json",
    JSON.stringify({ name: "wrangler", type: "module", main: "index.js" }),
  );
  writeFile(
    "node_modules/wrangler/index.js",
    `export * from ${JSON.stringify(realWranglerUrl)};\n`,
  );
  writeFile(
    "wrangler.jsonc",
    '{"name":"test-worker","main":"vinext/server/app-router-entry","assets":{"directory":"dist/client"},"version_metadata":{"binding":"CF_VERSION_METADATA"}}\n',
  );
  writeFile(
    "vite.config.ts",
    [
      'import { defineConfig } from "vite";',
      'import { cloudflare } from "@cloudflare/vite-plugin";',
      'import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter";',
      'import vinext from "../packages/vinext/src/index";',
      "",
      "export default defineConfig({",
      "  plugins: [vinext({ cache: { cdn: { adapter: cdnAdapter().adapter } } }), cloudflare()],",
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
    emitPrerenderPathManifestMock.mockClear();
    discoverPrerenderPathManifestMock.mockClear();
    resolveTPRRoutesMock.mockClear();
    vi.mocked(execFileSync).mockClear();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects a missing CDN version binding before uploading", async () => {
    writeApiOnlyProject();
    writeFile(
      "wrangler.jsonc",
      '{"name":"test-worker","main":"vinext/server/app-router-entry","assets":{"directory":"dist/client"}}\n',
    );
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await expect(deploy({ root: tmpDir, skipBuild: true, warmCdnCache: true })).rejects.toThrow(
      "does not declare version_metadata",
    );
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["true", '{ routes: "*" }'])(
    "ignores runtime prerender config during Cloudflare deploy: %s",
    async (prerenderConfig) => {
      writeProject(prerenderConfig);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { deploy } = await import("../packages/cloudflare/src/deploy.js");

      await deploy({ root: tmpDir, skipBuild: true });

      expect(runPrerenderMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "vinext prerender config is ignored by Cloudflare deploy. Use --experimental-warm-cdn-cache",
        ),
      );
      warn.mockRestore();
    },
  );

  it("ignores --prerender-all during Worker deploys", async () => {
    writeProject("true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, prerenderAll: true });

    expect(runPrerenderMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "--prerender-all is ignored by Cloudflare deploy. Use --experimental-warm-cdn-cache",
      ),
    );
    warn.mockRestore();
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

  it.each([
    ["TPR despite an ignored prerender setting", "true", false],
    ["explicit CDN warming", undefined, true],
  ])("keeps %s when TPR is also enabled", async (_, prerender, warmCdn) => {
    writeProject(prerender, '{ data: kvDataAdapter({ binding: "MY_KV" }) }');
    writeFile(
      "wrangler.jsonc",
      '{"name":"test-worker","main":"vinext/server/app-router-entry","assets":{"directory":"dist/client"}}\n',
    );
    writeFile(
      "node_modules/wrangler/package.json",
      JSON.stringify({ name: "wrangler", type: "module", main: "index.js" }),
    );
    writeFile(
      "node_modules/wrangler/index.js",
      `export * from ${JSON.stringify(realWranglerUrl)};\n`,
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>About</html>", {
          headers: {
            "Content-Type": "text/html",
            "X-Vinext-Build-Id": "build-a",
            "X-Vinext-Cache": "MISS",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");
    resolveTPRRoutesMock.mockResolvedValueOnce({
      routes: [{ path: "/missing", requests: 10 }],
    });

    await deploy({
      root: tmpDir,
      skipBuild: true,
      experimentalTPR: true,
      warmCdnCache: warmCdn,
      warmCdnPromotionDelay: 0,
      warmCdnReadinessProbeDelay: 0,
      warmCdnReadinessProbes: 1,
    });

    expect(fs.readFileSync(path.join(tmpDir, "config-load-count.txt"), "utf8")).toBe("1");
    expect(runPrerenderMock).not.toHaveBeenCalled();
    expect(resolveTPRRoutesMock).toHaveBeenCalledOnce();
    if (prerender) {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("vinext prerender config is ignored by Cloudflare deploy"),
      );
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
    warn.mockRestore();
    expect(fs.existsSync(path.join(tmpDir, "dist/server/vinext-prerender-paths.json"))).toBe(false);
    expect(discoverPrerenderPathManifestMock).toHaveBeenCalledOnce();
    expect(discoverPrerenderPathManifestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        candidatePaths: ["/missing"],
        requestRouting: "uncached-stage",
      }),
    );
    if (warmCdn) expect(fetchMock).toHaveBeenCalled();
    expect(
      vi.mocked(spawn).mock.calls.some(([, args]) => {
        const wranglerArgs = args as string[];
        return wranglerArgs.includes("kv") && wranglerArgs.includes("bulk");
      }),
    ).toBe(false);
    expect(
      vi.mocked(execFileSync).mock.calls.some(([, args]) => {
        const wranglerArgs = args as string[];
        return wranglerArgs.includes("versions") && wranglerArgs.includes("upload");
      }),
    ).toBe(true);
  });

  it("allows TPR no-promote deploys with no resolved warm routes", async () => {
    writeProject(undefined, '{ data: kvDataAdapter({ binding: "MY_KV" }) }');
    writeFile(
      "node_modules/wrangler/package.json",
      JSON.stringify({ name: "wrangler", type: "module", main: "index.js" }),
    );
    writeFile(
      "node_modules/wrangler/index.js",
      `export * from ${JSON.stringify(realWranglerUrl)};\n`,
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    resolveTPRRoutesMock.mockResolvedValueOnce({
      routes: [{ path: "/missing", requests: 10 }],
    });
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deploy({
        root: tmpDir,
        skipBuild: true,
        experimentalTPR: true,
        warmCdnPromote: false,
      }),
    ).resolves.toBeUndefined();

    expect(
      vi.mocked(execFileSync).mock.calls.some(([, args]) => (args as string[]).includes("upload")),
    ).toBe(true);
    expect(discoverPrerenderPathManifestMock).toHaveBeenCalledWith(
      expect.objectContaining({ candidatePathsOnly: true }),
    );
  });

  it("uses a normal deploy when TPR has no cache warmup identity", async () => {
    writeProject(undefined);
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, experimentalTPR: true });

    expect(resolveTPRRoutesMock).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toEqual([
      expect.stringContaining("wrangler"),
      "deploy",
    ]);
  });

  it("tells legacy imperative cache users to migrate for TPR warming", async () => {
    writeProject(undefined);
    writeFile(
      "worker/index.ts",
      'import { setDataCacheHandler } from "vinext/shims/cache";\nsetDataCacheHandler(handler);\n',
    );
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "test-worker",
        main: "worker/index.ts",
        kv_namespaces: [{ binding: "VINEXT_KV_CACHE", id: "namespace-id" }],
      }),
    );
    const log = vi.spyOn(console, "log");
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, experimentalTPR: true });

    expect(log).toHaveBeenCalledWith(
      "  TPR: Skipping pre-warm (legacy imperative cache handlers must migrate to declarative vinext({ cache }) for standard warming)",
    );
    log.mockRestore();
  });

  it("uses a normal deploy when a TPR warmup cannot be staged safely", async () => {
    writeProject(undefined, '{ data: kvDataAdapter({ binding: "MY_KV" }) }');
    writeFile(
      "node_modules/wrangler/package.json",
      JSON.stringify({ name: "wrangler", type: "module", main: "index.js" }),
    );
    writeFile(
      "node_modules/wrangler/index.js",
      `export * from ${JSON.stringify(realWranglerUrl)};\n`,
    );
    resolveTPRRoutesMock.mockResolvedValueOnce({ routes: [{ path: "/hot", requests: 10 }] });
    vi.mocked(execFileSync).mockImplementationOnce(() =>
      JSON.stringify({
        versions: [
          { version_id: "11111111-1111-4111-8111-111111111111", percentage: 50 },
          { version_id: "22222222-2222-4222-8222-222222222222", percentage: 50 },
        ],
      }),
    );
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, experimentalTPR: true });

    expect(resolveTPRRoutesMock).toHaveBeenCalledOnce();
    expect(
      vi.mocked(execFileSync).mock.calls.some(([, args]) => (args as string[]).includes("upload")),
    ).toBe(false);
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toEqual([
      expect.stringContaining("wrangler"),
      "deploy",
    ]);
  });

  it.each([undefined, false])(
    "falls back to a normal deploy when optional TPR warming fails (promote: %s)",
    async (promote) => {
      writeProject(undefined, '{ data: kvDataAdapter({ binding: "MY_KV" }) }');
      writeFile(
        "node_modules/wrangler/package.json",
        JSON.stringify({ name: "wrangler", type: "module", main: "index.js" }),
      );
      writeFile(
        "node_modules/wrangler/index.js",
        `export * from ${JSON.stringify(realWranglerUrl)};\n`,
      );
      resolveTPRRoutesMock.mockResolvedValueOnce({ routes: [{ path: "/hot", requests: 10 }] });
      vi.mocked(execFileSync)
        .mockImplementationOnce(() =>
          JSON.stringify({
            versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
          }),
        )
        .mockImplementationOnce(() => {
          throw new Error("warm upload failed");
        });
      const log = vi.spyOn(console, "log");
      const { deploy } = await import("../packages/cloudflare/src/deploy.js");

      await expect(
        deploy({
          root: tmpDir,
          skipBuild: true,
          experimentalTPR: true,
          warmCdnPromote: promote,
        }),
      ).resolves.toBeUndefined();

      expect(log).toHaveBeenCalledWith(
        "  TPR: Skipping pre-warm (warm upload failed). Continuing with deploy.",
      );
      if (promote === false) {
        expect(
          vi
            .mocked(execFileSync)
            .mock.calls.filter(([, args]) => (args as string[]).includes("upload")),
        ).toHaveLength(2);
        expect(spawn).not.toHaveBeenCalled();
      } else {
        expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toEqual([
          expect.stringContaining("wrangler"),
          "deploy",
        ]);
      }
      log.mockRestore();
    },
  );

  it("does not hide a post-stage TPR failure when promotion is disabled", async () => {
    writeProject(undefined, '{ data: kvDataAdapter({ binding: "MY_KV" }) }');
    writeFile(
      "node_modules/wrangler/package.json",
      JSON.stringify({ name: "wrangler", type: "module", main: "index.js" }),
    );
    writeFile(
      "node_modules/wrangler/index.js",
      `export * from ${JSON.stringify(realWranglerUrl)};\n`,
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/[slug]/page.tsx",
      "export const revalidate = 60; export default function Page() { return null; }\n",
    );
    resolveTPRRoutesMock.mockResolvedValueOnce({ routes: [{ path: "/hot", requests: 10 }] });
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deploy({
        root: tmpDir,
        skipBuild: true,
        experimentalTPR: true,
        warmCdnPromote: false,
      }),
    ).rejects.toThrow("Cannot discover warmup paths from the staged Worker");

    expect(
      vi
        .mocked(execFileSync)
        .mock.calls.some(([, args]) =>
          (args as string[]).includes("22222222-2222-4222-8222-222222222222@0%"),
        ),
    ).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
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

  it("packages local prerender output in the configured client directory", async () => {
    writeProject("true", "{ cdn: staticAssetsAdapter() }");
    const viteConfigPath = path.join(tmpDir, "vite.config.ts");
    fs.writeFileSync(
      viteConfigPath,
      fs
        .readFileSync(viteConfigPath, "utf8")
        .replace("vinext({ prerender:", 'vinext({ clientOutDir: "build/client", prerender:'),
    );
    runPrerenderMock.mockImplementationOnce(async () => {
      writeFile(
        "dist/server/vinext-prerender.json",
        JSON.stringify({
          buildId: "build-1",
          routes: [{ route: "/", status: "rendered", revalidate: false, router: "app" }],
        }),
      );
      writeFile("dist/server/prerendered-routes/index.html", "<html>Home</html>");
      writeFile("dist/server/prerendered-routes/index.rsc", "flight");
      return { routes: [] };
    });
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true });

    expect(runPrerenderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: tmpDir,
        nextConfig: expect.not.objectContaining({ output: "export" }),
      }),
    );
    expect(fs.existsSync(path.join(tmpDir, "build/client/_vinext/static-cache/index.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tmpDir, "dist/client/_vinext/static-cache/index.json"))).toBe(
      false,
    );
  });

  it("passes deploy prerender concurrency through static export", async () => {
    writeProjectWithInlineNextConfig('{ output: "export" }');
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

  it("discovers warmup paths during skip-build warm CDN deploys", async () => {
    writeApiOnlyProject();
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, warmCdnCache: true });

    expect(runPrerenderMock).not.toHaveBeenCalled();

    expect(fs.existsSync(path.join(tmpDir, "dist/server/vinext-prerender-paths.json"))).toBe(false);
    expect(discoverPrerenderPathManifestMock).toHaveBeenCalledOnce();
    expect(
      vi.mocked(execFileSync).mock.calls.some(([, args]) => {
        const wranglerArgs = args as string[];
        return wranglerArgs.includes("versions") && wranglerArgs.includes("upload");
      }),
    ).toBe(true);
    expect(
      vi.mocked(execFileSync).mock.calls.some(([, args]) => {
        const wranglerArgs = args as string[];
        return wranglerArgs.includes("versions") && wranglerArgs.includes("deploy");
      }),
    ).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps default discovery retries deadline-bounded and forwards explicit limits", async () => {
    writeApiOnlyProject();
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await deploy({ root: tmpDir, skipBuild: true, warmCdnCache: true });

    expect(discoverPrerenderPathManifestMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pathDiscoveryTarget: expect.objectContaining({ retries: undefined }),
      }),
    );

    discoverPrerenderPathManifestMock.mockClear();
    await deploy({
      root: tmpDir,
      skipBuild: true,
      warmCdnCache: true,
      warmCdnDiscoveryRetries: 7,
    });

    expect(discoverPrerenderPathManifestMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pathDiscoveryTarget: expect.objectContaining({ retries: 7 }),
      }),
    );
  });

  it("rejects no-promote warmup when discovery finds no requests", async () => {
    writeApiOnlyProject();
    const { deploy } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deploy({
        root: tmpDir,
        skipBuild: true,
        warmCdnCache: true,
        warmCdnPromote: false,
      }),
    ).rejects.toThrow("no build-discovered requests were found to warm");
    expect(spawn).not.toHaveBeenCalled();
  });
});
