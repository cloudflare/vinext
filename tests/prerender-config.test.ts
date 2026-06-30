import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  findVinextPrerenderConfigInPlugins,
  formatVinextPrerenderLabel,
  normalizeVinextPrerenderConfig,
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

  it("exposes normalized config on the vinext plugin for build-time config loading", () => {
    const plugins = vinext({ prerender: true });
    expect(findVinextPrerenderConfigInPlugins(plugins)).toEqual({ routes: "*" });
  });

  it("exposes object-form config on the vinext plugin", () => {
    const plugins = vinext({ prerender: { routes: "*" } });
    expect(findVinextPrerenderConfigInPlugins(plugins)).toEqual({ routes: "*" });
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
