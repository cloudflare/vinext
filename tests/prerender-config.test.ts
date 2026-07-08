import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  findVinextNextConfigInPlugins,
  resolveNextConfigInput,
} from "../packages/vinext/src/config/next-config.js";
import { PHASE_PRODUCTION_BUILD } from "../packages/vinext/src/shims/constants.js";
import {
  findVinextPrerenderConfigInPlugins,
  findVinextRouteRootConfigInPlugins,
  formatVinextPrerenderLabel,
  normalizeVinextPrerenderConfig,
  loadVinextPrerenderConfigFromViteConfig,
  loadVinextRouteRootConfigFromViteConfig,
  resolveVinextPrerenderDecision,
} from "../packages/vinext/src/config/prerender.js";

describe("vinext prerender config", () => {
  it("normalizes true to all routes", () => {
    expect(normalizeVinextPrerenderConfig(true)).toEqual({ routes: "*" });
  });

  it("accepts the explicit all-routes object form", () => {
    expect(normalizeVinextPrerenderConfig({ routes: "*" })).toEqual({ routes: "*" });
  });

  it("treats undefined as disabled", () => {
    expect(normalizeVinextPrerenderConfig(undefined)).toBeNull();
  });

  it("rejects false", () => {
    expect(() => normalizeVinextPrerenderConfig(false as never)).toThrow(
      'Use `true` or `{ routes: "*" }`',
    );
  });

  it("rejects route selections other than star", () => {
    expect(() =>
      normalizeVinextPrerenderConfig({ routes: ["/"] } as unknown as { routes: "*" }),
    ).toThrow('Currently only `routes: "*"` is supported');
  });

  it("exposes normalized config on the vinext plugin for build-time config loading", async () => {
    const plugins = vinext({ prerender: true });
    expect(await findVinextPrerenderConfigInPlugins(plugins)).toEqual({ routes: "*" });
  });

  it("exposes object-form config on the vinext plugin", async () => {
    const plugins = vinext({ prerender: { routes: "*" } });
    expect(await findVinextPrerenderConfigInPlugins(plugins)).toEqual({ routes: "*" });
  });

  it("discovers prerender config through promised plugin composition", async () => {
    const plugins = [Promise.resolve(vinext({ prerender: true }))];
    expect(await findVinextPrerenderConfigInPlugins(plugins)).toEqual({ routes: "*" });
  });

  it("discovers route-root config through promised plugin composition", async () => {
    const plugins = [Promise.resolve(vinext({ appDir: "custom-app", disableAppRouter: true }))];
    expect(await findVinextRouteRootConfigInPlugins(plugins)).toMatchObject({
      appDir: "custom-app",
      disableAppRouter: true,
    });
  });

  it("preserves promise-aware metadata loading through the internal Vite wrappers", async () => {
    const plugins = Promise.resolve(vinext({ prerender: true, appDir: "custom-app" }));
    const vite = {
      loadConfigFromFile: async () => ({ config: { plugins: [plugins] } }),
    } as never;

    await expect(loadVinextPrerenderConfigFromViteConfig(vite, "/tmp/app")).resolves.toEqual({
      routes: "*",
    });
    await expect(loadVinextRouteRootConfigFromViteConfig(vite, "/tmp/app")).resolves.toMatchObject({
      appDir: "custom-app",
    });
  });

  it("exposes inline Next.js config on the vinext plugin for CLI build metadata", async () => {
    const nextConfig = { output: "export" } as const;
    const plugins = vinext({ nextConfig });
    expect(await findVinextNextConfigInPlugins(plugins)).toBe(nextConfig);
  });

  it("discovers inline Next.js config through promised plugin composition", async () => {
    const nextConfig = { output: "export" } as const;
    const plugins = Promise.resolve(vinext({ nextConfig }));
    expect(await findVinextNextConfigInPlugins([plugins])).toBe(nextConfig);
  });

  it("preserves function-form inline config for production build resolution", async () => {
    const nextConfig = (phase: string) => ({
      output: phase === PHASE_PRODUCTION_BUILD ? ("export" as const) : undefined,
    });
    const plugins = vinext({ nextConfig });
    const discoveredConfig = await findVinextNextConfigInPlugins(plugins);

    expect(discoveredConfig).toBe(nextConfig);
    expect(await resolveNextConfigInput(discoveredConfig!, PHASE_PRODUCTION_BUILD)).toEqual({
      output: "export",
    });
  });

  it("chooses the CLI flag before config or static export", () => {
    expect(
      resolveVinextPrerenderDecision({
        prerenderAllFlag: true,
        vinextPrerenderConfig: { routes: "*" },
        nextOutput: "export",
      }),
    ).toEqual({ routes: "*", reason: "flag" });
  });

  it("uses next.config static export before vinext config", () => {
    expect(
      resolveVinextPrerenderDecision({
        vinextPrerenderConfig: { routes: "*" },
        nextOutput: "export",
      }),
    ).toEqual({ routes: "*", reason: "next-export" });
  });

  it("uses vinext config when no higher-priority prerender trigger exists", () => {
    expect(
      resolveVinextPrerenderDecision({
        vinextPrerenderConfig: { routes: "*" },
      }),
    ).toEqual({ routes: "*", reason: "vinext-config" });
  });

  it("returns no decision when prerendering is not configured", () => {
    expect(resolveVinextPrerenderDecision({ nextOutput: undefined })).toBeNull();
  });

  it("formats labels for each prerender trigger", () => {
    expect(formatVinextPrerenderLabel({ routes: "*", reason: "flag" })).toBe(
      "Pre-rendering all routes...",
    );
    expect(formatVinextPrerenderLabel({ routes: "*", reason: "next-export" })).toBe(
      "Pre-rendering all routes (output: 'export')...",
    );
    expect(formatVinextPrerenderLabel({ routes: "*", reason: "vinext-config" })).toBe(
      "Pre-rendering all routes (vinext prerender config)...",
    );
  });
});
