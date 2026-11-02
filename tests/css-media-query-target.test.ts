/**
 * CSS media-query syntax preservation in production builds.
 *
 * Verifies that vinext's `build.cssTarget` is pinned old enough to stop
 * the CSS minifier from rewriting `@media (max-width: ...)` queries
 * to the Media Queries Level 4 range syntax `@media (width <= ...)`.
 *
 * Ported from Next.js: test/e2e/app-dir/css-media-query/css-media-query.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/css-media-query/css-media-query.test.ts
 *
 * The two forms are semantically equivalent, but the rewrite is observable
 * to user code that inspects `cssText` of `CSSMediaRule`s and breaks tools
 * that pattern-match the raw query string. Next.js does not perform this
 * rewrite by default; matching that behavior is required for parity.
 */
import { describe, it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig, type InlineConfig, type Plugin, type UserConfig } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

type CssTarget = NonNullable<UserConfig["build"]>["cssTarget"];

const PAGES_FIXTURE = path.resolve(import.meta.dirname, "fixtures/css-media-query-pages");
const APP_FIXTURE = path.resolve(import.meta.dirname, "fixtures/app-basic");
const PIN = ["chrome111", "edge111", "firefox114", "safari15"];

function makeFixture(): Promise<string> {
  return createIsolatedFixture(PAGES_FIXTURE, "vinext-css-mq-");
}

async function findBuiltCss(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".css")) {
      // `entry.parentPath` is the directory; older Node uses `entry.path`.
      const parent =
        (entry as { parentPath?: string; path?: string }).parentPath ??
        (entry as { path?: string }).path ??
        dir;
      return fs.readFile(path.join(parent, entry.name), "utf8");
    }
  }
  throw new Error(`No .css asset found under ${dir}`);
}

describe("CSS media-query syntax preservation in production build", () => {
  it("preserves `max-width: ...` instead of rewriting to range syntax", async () => {
    const tmpDir = await makeFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-mq-build-"));
    try {
      await build({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        build: {
          outDir: path.join(outDir, "client"),
          manifest: true,
          ssrManifest: true,
          rolldownOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      const css = await findBuiltCss(path.join(outDir, "client"));

      // Should preserve `max-width: 768px` (with any whitespace).
      expect(css).toMatch(/max-width\s*:\s*768px/);
      // Should NOT rewrite to MQ Level 4 range syntax.
      expect(css).not.toMatch(/width\s*<=\s*768px/);
      expect(css).not.toMatch(/width<=768px/);

      // Original color values may be minified, but the media block must
      // still gate them (sanity check: the build did emit the rule).
      expect(css).toMatch(/@media[^{]*max-width[^{]*768px/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  // Firefox 121 / Safari 15.6 are newer than the pin (firefox114 / safari15).
  // Before #4413, Vite concatenated both lists and the CSS minifier kept the
  // older version of each browser, so an app could never raise the target.
  const userTarget = ["chrome111", "edge111", "firefox121", "safari15.6"];

  async function resolveTargets(config: InlineConfig, root = PAGES_FIXTURE) {
    const resolved = await resolveConfig(
      {
        root,
        configFile: false,
        plugins: [vinext({ disableAppRouter: root === PAGES_FIXTURE })],
        logLevel: "silent",
        ...config,
      },
      "build",
    );
    return {
      top: resolved.build.cssTarget,
      ...Object.fromEntries(
        Object.entries(resolved.environments).map(([name, env]) => [name, env.build.cssTarget]),
      ),
    };
  }

  it("pins cssTarget everywhere when nothing sets one", async () => {
    expect(await resolveTargets({})).toEqual({ top: PIN, client: PIN, ssr: PIN });
  }, 30_000);

  it("pins cssTarget in every App Router environment when nothing sets one", async () => {
    expect(await resolveTargets({}, APP_FIXTURE)).toEqual({
      top: PIN,
      rsc: PIN,
      ssr: PIN,
      client: PIN,
    });
  }, 30_000);

  it("does not append the pinned cssTarget to an App Router app's own", async () => {
    expect(await resolveTargets({ build: { cssTarget: userTarget } }, APP_FIXTURE)).toEqual({
      top: userTarget,
      rsc: userTarget,
      ssr: userTarget,
      client: userTarget,
    });
  }, 30_000);

  it("does not append the pinned cssTarget when the app sets its own", async () => {
    expect(await resolveTargets({ build: { cssTarget: userTarget } })).toEqual({
      top: userTarget,
      client: userTarget,
      ssr: userTarget,
    });
  }, 30_000);

  it.each<[string, Plugin]>([
    ["config", { name: "test:later", config: () => ({ build: { cssTarget: userTarget } }) }],
    [
      "post-ordered config",
      {
        name: "test:later",
        enforce: "post",
        config: { order: "post", handler: () => ({ build: { cssTarget: userTarget } }) },
      },
    ],
  ])(
    "does not append the pinned cssTarget when a later plugin's %s hook sets one",
    async (_, later) => {
      expect(
        await resolveTargets({ plugins: [vinext({ disableAppRouter: true }), later] }),
      ).toEqual({ top: userTarget, client: userTarget, ssr: userTarget });
    },
    30_000,
  );

  it("does not append the pinned cssTarget when a later plugin's configEnvironment hook sets one", async () => {
    const later: Plugin = {
      name: "test:later",
      enforce: "post",
      configEnvironment: {
        order: "post",
        handler: (name) => ({ build: { cssTarget: name === "client" ? false : userTarget } }),
      },
    };
    expect(await resolveTargets({ plugins: [vinext({ disableAppRouter: true }), later] })).toEqual({
      top: PIN,
      client: false,
      ssr: userTarget,
    });
  }, 30_000);

  it.each<[string, CssTarget[], CssTarget]>([
    ["a later scalar replaces an earlier one", ["firefox114", false], false],
    ["two scalars resolve to the last", ["firefox114", "safari17"], "safari17"],
    ["an explicit empty array is kept", [[]], []],
  ])(
    "resolves later plugin targets like Vite: %s",
    async (_, targets, expected) => {
      const later = targets.map((cssTarget, index): Plugin => ({
        name: `test:later-${index}`,
        config: { order: "post", handler: () => ({ build: { cssTarget } }) },
      }));
      expect(
        await resolveTargets({ plugins: [vinext({ disableAppRouter: true }), ...later] }),
      ).toEqual({ top: expected, client: expected, ssr: expected });
    },
    30_000,
  );

  it("lets a later plugin's conditional default see an unset cssTarget", async () => {
    const later: Plugin = {
      name: "test:later-default",
      enforce: "post",
      config: {
        order: "post",
        handler: (config) =>
          config.build?.cssTarget === undefined ? { build: { cssTarget: userTarget } } : undefined,
      },
    };
    expect(await resolveTargets({ plugins: [vinext({ disableAppRouter: true }), later] })).toEqual({
      top: userTarget,
      client: userTarget,
      ssr: userTarget,
    });
  }, 30_000);

  it("pins cssTarget when the app sets only build.target", async () => {
    expect(await resolveTargets({ build: { target: "es2022" } })).toEqual({
      top: PIN,
      client: PIN,
      ssr: PIN,
    });
  }, 30_000);

  it.each<[string, CssTarget]>([
    ["a browser", "chrome120"],
    ["false", false],
  ])(
    "keeps a cssTarget that matches build.target: %s",
    async (_, target) => {
      expect(await resolveTargets({ build: { target, cssTarget: target } })).toEqual({
        top: target,
        client: target,
        ssr: target,
      });
    },
    30_000,
  );

  it("keeps a matching cssTarget set by a later plugin's post-ordered config hook", async () => {
    const later: Plugin = {
      name: "test:later-browser-target",
      enforce: "post",
      config: {
        order: "post",
        handler: () => ({ build: { target: "chrome120", cssTarget: "chrome120" } }),
      },
    };
    expect(await resolveTargets({ plugins: [vinext({ disableAppRouter: true }), later] })).toEqual({
      top: "chrome120",
      client: "chrome120",
      ssr: "chrome120",
    });
  }, 30_000);

  it("keeps per-environment cssTarget values as declared", async () => {
    expect(
      await resolveTargets({
        environments: {
          client: { build: { cssTarget: false } },
          ssr: { build: { cssTarget: userTarget } },
        },
      }),
    ).toEqual({ top: PIN, client: false, ssr: userTarget });
  }, 30_000);

  it("minifies CSS for a raised cssTarget", async () => {
    const tmpDir = await makeFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-mq-build-"));
    try {
      await build({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        // Every engine here supports range syntax, so the minifier may use it.
        build: {
          cssTarget: ["chrome120", "edge120", "firefox121", "safari17.2"],
          outDir: path.join(outDir, "client"),
          rolldownOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      expect(await findBuiltCss(path.join(outDir, "client"))).toMatch(/width\s*<=\s*768px/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("minifies with an environment's cssTarget that matches its build.target", async () => {
    const tmpDir = await makeFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-mq-build-"));
    try {
      // This build copies the client environment's `build` to the top level,
      // which is what Vite's CSS plugin minifies with.
      await build({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        environments: { client: { build: { target: "chrome120", cssTarget: "chrome120" } } },
        build: {
          outDir: path.join(outDir, "client"),
          rolldownOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      expect(await findBuiltCss(path.join(outDir, "client"))).toMatch(/width\s*<=\s*768px/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("builds when an environment sets cssTarget to false", async () => {
    const tmpDir = await makeFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-mq-build-"));
    try {
      // `[...pin, false]` used to reach Lightning CSS and fail the build.
      await build({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        environments: { client: { build: { cssTarget: false } } },
        build: {
          outDir: path.join(outDir, "client"),
          rolldownOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      expect(await findBuiltCss(path.join(outDir, "client"))).toMatch(/@media[^{]*768px/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
