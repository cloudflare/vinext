import path from "node:path";
import type { ViteBuilder } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BuildLifecycleContext } from "../packages/vinext/src/build/lifecycle.js";

const runPrerender = vi.fn(async () => null);
const emitPrerenderPathManifest = vi.fn(async () => null);
const emitStandaloneOutput = vi.fn(() => ({
  standaloneDir: path.join(process.cwd(), "dist", "standalone"),
}));
const printBuildReport = vi.fn(async () => {});

vi.mock("../packages/vinext/src/build/run-prerender.js", () => ({
  runPrerender: (...args: unknown[]) => runPrerender(...(args as [])),
}));

vi.mock("../packages/vinext/src/build/prerender-paths.js", () => ({
  emitPrerenderPathManifest: (...args: unknown[]) => emitPrerenderPathManifest(...(args as [])),
}));

vi.mock("../packages/vinext/src/build/standalone.js", () => ({
  emitStandaloneOutput: (...args: unknown[]) => emitStandaloneOutput(...(args as [])),
}));

vi.mock("../packages/vinext/src/build/report.js", () => ({
  printBuildReport: (...args: unknown[]) => printBuildReport(...(args as [])),
}));

const { createBuildLifecyclePlugins } = await import("../packages/vinext/src/build/lifecycle.js");

// Next.js runs `writeStandaloneDirectory` after static generation and passes it
// the collected `staticPages`, so `.next/standalone` contains the prerendered
// output. vinext must keep that ordering or a standalone build silently drops
// every prerendered artifact.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/index.ts
// (`if (config.output === 'standalone') { await writeStandaloneDirectory(..., staticPages, ...) }`)

function finalizeWith(options: {
  output?: string;
  prerenderAll?: boolean;
  prerenderConfig?: BuildLifecycleContext["prerenderConfig"];
}): Promise<void> {
  const builder = { environments: {} } as unknown as ViteBuilder;
  const context = {
    root: process.cwd(),
    nextConfig: { output: options.output },
    prerenderAll: options.prerenderAll,
    prerenderConfig: options.prerenderConfig,
  } as unknown as BuildLifecycleContext;
  const plugins = createBuildLifecyclePlugins({
    createContext: () => context,
    isEnabled: () => true,
    shouldPrepare: () => false,
    shouldBuildPlainPages: () => false,
  });
  const finalize = plugins.find((plugin) => plugin.name === "vinext:build-lifecycle-finalize")
    ?.buildApp as { handler: (builder: ViteBuilder) => Promise<void> };

  return finalize.handler(builder);
}

describe("standalone build lifecycle ordering", () => {
  it("prerenders before emitting standalone output", async () => {
    runPrerender.mockClear();
    emitPrerenderPathManifest.mockClear();
    emitStandaloneOutput.mockClear();
    printBuildReport.mockClear();

    const order: string[] = [];
    runPrerender.mockImplementationOnce(async () => {
      order.push("prerender");
      return null;
    });
    emitStandaloneOutput.mockImplementationOnce(() => {
      order.push("standalone");
      return { standaloneDir: path.join(process.cwd(), "dist", "standalone") };
    });

    await finalizeWith({ output: "standalone", prerenderConfig: { routes: "*" } });

    expect(order).toEqual(["prerender", "standalone"]);
  });

  it("emits standalone output when the lifecycle prerenderAll flag is set", async () => {
    runPrerender.mockClear();
    emitStandaloneOutput.mockClear();
    runPrerender.mockImplementationOnce(async () => null);

    await finalizeWith({ output: "standalone", prerenderAll: true });

    expect(runPrerender).toHaveBeenCalledOnce();
    expect(emitStandaloneOutput).toHaveBeenCalledOnce();
  });

  it("still emits standalone output when no prerender is requested", async () => {
    runPrerender.mockClear();
    emitStandaloneOutput.mockClear();
    printBuildReport.mockClear();

    await finalizeWith({ output: "standalone" });

    expect(runPrerender).not.toHaveBeenCalled();
    expect(emitStandaloneOutput).toHaveBeenCalledOnce();
    // The standalone branch returns before the build report, as before.
    expect(printBuildReport).not.toHaveBeenCalled();
  });

  it("leaves non-standalone builds reporting after prerendering", async () => {
    runPrerender.mockClear();
    printBuildReport.mockClear();
    emitStandaloneOutput.mockClear();
    runPrerender.mockImplementationOnce(async () => null);

    await finalizeWith({ prerenderAll: true });

    expect(runPrerender).toHaveBeenCalledOnce();
    expect(printBuildReport).toHaveBeenCalledOnce();
    expect(emitStandaloneOutput).not.toHaveBeenCalled();
  });
});
