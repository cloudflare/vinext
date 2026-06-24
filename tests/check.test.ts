import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanImports,
  analyzeConfig,
  checkLibraries,
  checkConventions,
  hasFreeCjsGlobal,
  runCheck,
  formatReport,
  type CheckResult,
} from "../packages/vinext/src/check.js";

// ── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-check-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

// ── scanImports ────────────────────────────────────────────────────────────

describe("scanImports", () => {
  it("detects supported next/* imports", () => {
    writeFile(
      "app/page.tsx",
      `
      import Link from "next/link";
      import Image from "next/image";
    `,
    );

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.name === "next/link")?.status).toBe("supported");
    expect(items.find((i) => i.name === "next/image")?.status).toBe("supported");
  });

  it("detects partial imports", () => {
    writeFile("app/page.tsx", `import { GoogleFont } from "next/font/google";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/font/google");
    expect(items[0].status).toBe("partial");
  });

  it("reports accurate next/font/local detail", () => {
    writeFile("app/page.tsx", `import localFont from "next/font/local";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/font/local");
    expect(items[0].status).toBe("supported");
    expect(items[0].detail).toContain("className and variable modes both work");
  });

  it("detects unsupported imports", () => {
    writeFile("pages/amp.tsx", `import { useAmp } from "next/amp";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/amp");
    expect(items[0].status).toBe("unsupported");
  });

  it("detects server-only and client-only", () => {
    writeFile("lib/db.ts", `import "server-only";`);
    writeFile("components/button.tsx", `import "client-only";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.name === "server-only")?.status).toBe("supported");
    expect(items.find((i) => i.name === "client-only")?.status).toBe("supported");
  });

  it("tracks which files use each import", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile("app/about/page.tsx", `import Link from "next/link";`);

    const items = scanImports(tmpDir);
    const linkItem = items.find((i) => i.name === "next/link");
    expect(linkItem?.files).toHaveLength(2);
    expect(linkItem?.files).toContain("app/page.tsx");
    expect(linkItem?.files).toContain("app/about/page.tsx");
  });

  it("detects require() calls too", () => {
    writeFile("lib/util.js", `const router = require("next/router");`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/router");
    expect(items[0].status).toBe("supported");
  });

  it("returns empty for projects with no next imports", () => {
    writeFile("src/index.ts", `import React from "react";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(0);
  });

  it("marks unrecognized next/* imports as unsupported", () => {
    writeFile("app/page.tsx", `import foo from "next/nonexistent";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("unsupported");
    expect(items[0].detail).toContain("not recognized");
  });

  it("recognizes next/compat/router as supported", () => {
    writeFile("components/shared-nav.tsx", `import { useRouter } from "next/compat/router";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/compat/router");
    expect(items[0].status).toBe("supported");
  });

  it("recognizes next/form as supported", () => {
    writeFile("app/page.tsx", `import Form from "next/form";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/form");
    expect(items[0].status).toBe("supported");
  });

  it("recognizes next/web-vitals as supported", () => {
    writeFile("pages/_app.tsx", `import { reportWebVitals } from "next/web-vitals";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/web-vitals");
    expect(items[0].status).toBe("supported");
  });

  it("recognizes next/constants as supported", () => {
    writeFile("lib/phases.ts", `import { PHASE_DEVELOPMENT_SERVER } from "next/constants";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/constants");
    expect(items[0].status).toBe("supported");
  });

  it("recognizes `import { Metadata } from 'next'` as supported", () => {
    writeFile(
      "app/layout.tsx",
      `import { Metadata } from "next";\nexport const metadata: Metadata = { title: "App" };`,
    );

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next");
    expect(items[0].status).toBe("supported");
  });

  it("skips `import type` statements entirely", () => {
    writeFile(
      "app/page.tsx",
      `import type { Metadata } from "next";\nimport Link from "next/link";`,
    );

    const items = scanImports(tmpDir);
    // Should only find next/link, not next (since import type is skipped)
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/link");
  });

  it("skips `import type` for next/* paths too", () => {
    writeFile("app/page.tsx", `import type { NextRequest } from "next/server";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(0);
  });

  it("sorts unsupported first, then partial, then supported", () => {
    writeFile(
      "app/page.tsx",
      `
      import Link from "next/link";
      import { GoogleFont } from "next/font/google";
      import { useAmp } from "next/amp";
    `,
    );

    const items = scanImports(tmpDir);
    expect(items[0].status).toBe("unsupported");
    expect(items[1].status).toBe("partial");
    expect(items[2].status).toBe("supported");
  });

  it("ignores node_modules and .next directories", () => {
    writeFile("node_modules/foo/index.ts", `import Link from "next/link";`);
    writeFile(".next/server.js", `import Link from "next/link";`);
    writeFile("app/page.tsx", `import Image from "next/image";`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next/image");
  });

  it("deduplicates files using the same import", () => {
    writeFile(
      "app/page.tsx",
      `
      import Link from "next/link";
      import Link from "next/link";
    `,
    );

    const items = scanImports(tmpDir);
    const linkItem = items.find((i) => i.name === "next/link");
    expect(linkItem?.files).toHaveLength(1);
  });

  it("recognizes next/dist/shared/lib/router-context.shared-runtime as supported", () => {
    writeFile(
      "lib/router.tsx",
      `import { RouterContext } from "next/dist/shared/lib/router-context.shared-runtime";`,
    );

    const items = scanImports(tmpDir);
    const item = items.find((i) => i.name === "next/dist/shared/lib/router-context.shared-runtime");
    expect(item?.status).toBe("supported");
  });

  it("recognizes all other shimmed next/dist/* paths as supported", () => {
    const distImports = [
      "next/dist/shared/lib/app-router-context.shared-runtime",
      "next/dist/shared/lib/app-router-context",
      "next/dist/shared/lib/utils",
      "next/dist/server/api-utils",
      "next/dist/server/web/spec-extension/cookies",
      "next/dist/compiled/@edge-runtime/cookies",
      "next/dist/server/app-render/work-unit-async-storage.external",
      "next/dist/client/components/work-unit-async-storage.external",
      "next/dist/client/components/request-async-storage.external",
      "next/dist/client/components/request-async-storage",
      "next/dist/client/components/navigation",
      "next/dist/server/config-shared",
    ];

    writeFile("lib/internals.ts", distImports.map((p) => `import * as m from "${p}";`).join("\n"));

    const items = scanImports(tmpDir);
    for (const p of distImports) {
      const item = items.find((i) => i.name === p);
      expect(item?.status, `expected ${p} to be supported`).toBe("supported");
    }
  });
});

// ── analyzeConfig ──────────────────────────────────────────────────────────

describe("analyzeConfig", () => {
  it("reports 'no config file' when none exists", () => {
    const items = analyzeConfig(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next.config");
    expect(items[0].status).toBe("supported");
  });

  it("detects supported config options", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        basePath: "/docs",
        trailingSlash: true,
        reactStrictMode: true,
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "basePath")?.status).toBe("supported");
    expect(items.find((i) => i.name === "trailingSlash")?.status).toBe("supported");
    // reactStrictMode is reported as `partial` until vinext actually wraps the
    // hydrated root in `<React.StrictMode>` — currently the config is read but
    // not enforced. See `packages/vinext/src/check.ts` for the rationale.
    expect(items.find((i) => i.name === "reactStrictMode")?.status).toBe("partial");
  });

  it("detects unsupported webpack config", () => {
    writeFile(
      "next.config.js",
      `module.exports = {
        webpack: (config) => { return config; },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    const webpackItem = items.find((i) => i.name === "webpack");
    expect(webpackItem?.status).toBe("unsupported");
    expect(webpackItem?.detail).toContain("Vite replaces webpack");
  });

  it("does not flag webpack when it only appears in a comment", () => {
    writeFile(
      "next.config.js",
      `// We removed our custom webpack config when migrating to vinext.
      module.exports = {
        reactStrictMode: true,
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "webpack")).toBeUndefined();
  });

  it("does not flag webpack when it only appears as a substring of a value", () => {
    writeFile(
      "next.config.js",
      `module.exports = {
        env: { RSD: "react-server-dom-webpack" },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "webpack")).toBeUndefined();
  });

  it("does not flag an option mentioned in a comment with trailing punctuation", () => {
    // Reviewer case: the boundary + `:`/`(`/`=` follower alone would still
    // match these because the leading space satisfies the boundary. Comment
    // stripping is what prevents the false positive.
    writeFile(
      "next.config.js",
      `// TODO: webpack: removed, migrate to vite
      /* old webpack(config) hook lived here */
      // headers: we no longer set custom headers
      module.exports = {
        reactStrictMode: true,
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "webpack")).toBeUndefined();
    expect(items.find((i) => i.name === "headers")).toBeUndefined();
  });

  it("does not flag an option name embedded in a string value", () => {
    // Reviewer case: a `"<opt>:..."` value would slip past the optional-quote
    // branch of the regex; string stripping prevents it.
    writeFile(
      "next.config.js",
      `module.exports = {
        images: { domains: ["webpack:1234"] },
        env: { X: "(headers:foo)" },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "webpack")).toBeUndefined();
    expect(items.find((i) => i.name === "headers")).toBeUndefined();
    // The real keys are still detected.
    expect(items.find((i) => i.name === "images")?.status).toBe("partial");
    expect(items.find((i) => i.name === "env")?.status).toBe("supported");
  });

  it("detects webpack when written as a method shorthand", () => {
    writeFile(
      "next.config.js",
      `module.exports = {
        webpack(config) { return config; },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "webpack")?.status).toBe("unsupported");
  });

  it("detects webpack when written as a quoted property key", () => {
    writeFile(
      "next.config.js",
      `module.exports = {
        "webpack": (config) => config,
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "webpack")?.status).toBe("unsupported");
  });

  it("detects partial image config", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        images: { remotePatterns: [{ hostname: "*.example.com" }] },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "images")?.status).toBe("partial");
  });

  it("detects experimental.ppr as unsupported", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        experimental: {
          ppr: true,
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.ppr")?.status).toBe("unsupported");
  });

  // Mirrors Next.js: test/e2e/app-dir/app-shells
  it("detects experimental.appShells as partial (config recognized, behavior not implemented)", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        experimental: {
          appShells: true,
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.appShells")?.status).toBe("partial");
  });

  it("detects experimental.serverActions as supported", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        experimental: {
          serverActions: { allowedOrigins: ["my-domain.com"] },
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.serverActions")?.status).toBe("supported");
  });

  it("detects experimental.prefetchInlining as partial", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        experimental: {
          prefetchInlining: true,
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.prefetchInlining")?.status).toBe("partial");
  });

  it("detects experimental.varyParams as partial", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        experimental: {
          varyParams: true,
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.varyParams")?.status).toBe("partial");
  });

  it("detects experimental.optimisticRouting as partial", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        experimental: {
          optimisticRouting: true,
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.optimisticRouting")?.status).toBe("partial");
  });

  it("detects experimental.cachedNavigations as partial", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        experimental: {
          cachedNavigations: true,
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.cachedNavigations")?.status).toBe("partial");
  });

  it("detects experimental.swcEnvOptions as unsupported", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        experimental: {
          swcEnvOptions: {
            mode: "usage",
            coreJs: "3",
          },
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    const item = items.find((i) => i.name === "experimental.swcEnvOptions");
    expect(item?.status).toBe("unsupported");
    expect(item?.detail).toContain("not applicable");
  });

  it("detects unrecognized middleware and proxy config options as unsupported", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        skipMiddlewareUrlNormalize: true,
        skipProxyUrlNormalize: true,
        experimental: {
          middlewarePrefetch: "strict",
          proxyPrefetch: "strict",
          middlewareClientMaxBodySize: "5mb",
          proxyClientMaxBodySize: "5mb",
          externalMiddlewareRewritesResolve: true,
          externalProxyRewritesResolve: true,
          instrumentationHook: true,
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    const unsupportedNames = items
      .filter((item) => item.status === "unsupported")
      .map((item) => item.name);

    expect(unsupportedNames).toEqual([
      "skipMiddlewareUrlNormalize",
      "skipProxyUrlNormalize",
      "experimental.middlewarePrefetch",
      "experimental.proxyPrefetch",
      "experimental.middlewareClientMaxBodySize",
      "experimental.proxyClientMaxBodySize",
      "experimental.externalMiddlewareRewritesResolve",
      "experimental.externalProxyRewritesResolve",
      "experimental.instrumentationHook",
    ]);
  });

  it("detects allowedDevOrigins as supported", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        allowedDevOrigins: ["staging.example.com"],
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "allowedDevOrigins")?.status).toBe("supported");
  });

  it("detects i18n.domains as partial support", () => {
    writeFile(
      "next.config.js",
      `module.exports = {
        i18n: {
          locales: ["en", "fr"],
          defaultLocale: "en",
          domains: [{ domain: "example.fr", defaultLocale: "fr" }],
        },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "i18n")?.status).toBe("supported");
    expect(items.find((i) => i.name === "i18n.domains")?.status).toBe("partial");
  });

  it("does not flag i18n.domains when domains belongs to images, not i18n", () => {
    // Reviewer case: the old check tested parent and child as independent
    // regexes, so any config with both i18n and images.domains wrongly reported
    // i18n.domains. Scoping the child lookup to the i18n block fixes this.
    writeFile(
      "next.config.js",
      `module.exports = {
        i18n: { locales: ["en"], defaultLocale: "en" },
        images: { domains: ["x.com"] },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "i18n.domains")).toBeUndefined();
    expect(items.find((i) => i.name === "i18n")?.status).toBe("supported");
  });

  it("does not flag experimental.ppr when ppr is outside the experimental block", () => {
    writeFile(
      "next.config.js",
      `const ppr = true;
      module.exports = {
        experimental: { inlineCss: true },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.ppr")).toBeUndefined();
  });

  it("detects a nested option that only appears in a later same-named block", () => {
    // The block scan inspects every matching parent block, not just the first,
    // so a child living in a second `experimental: {}` is still found.
    writeFile(
      "next.config.js",
      `const a = { experimental: { inlineCss: true } };
      module.exports = { experimental: { ppr: true } };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.ppr")?.status).toBe("unsupported");
  });

  it("detects a nested option under a quoted parent key", () => {
    writeFile(
      "next.config.js",
      `module.exports = {
        "experimental": { ppr: true },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "experimental.ppr")?.status).toBe("unsupported");
  });

  it("detects options when the config is wrapped in a plugin call", () => {
    writeFile(
      "next.config.mjs",
      `import withMDX from "@next/mdx";
      const nextConfig = { basePath: "/docs", webpack: (c) => c };
      export default withMDX()(nextConfig);`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "basePath")?.status).toBe("supported");
    expect(items.find((i) => i.name === "webpack")?.status).toBe("unsupported");
  });

  it("detects options through a `satisfies` annotation", () => {
    writeFile(
      "next.config.ts",
      `export default { trailingSlash: true } satisfies import("next").NextConfig;`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "trailingSlash")?.status).toBe("supported");
  });

  it("detects options in a concise arrow function config", () => {
    // Documented Next.js function form: (phase) => config
    writeFile(
      "next.config.js",
      `module.exports = (phase) => ({
        basePath: "/app",
        webpack: (config) => config,
      });`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "basePath")?.status).toBe("supported");
    expect(items.find((i) => i.name === "webpack")?.status).toBe("unsupported");
  });

  it("detects options in a block-body function config (next/constants PHASE_*)", () => {
    writeFile(
      "next.config.js",
      `module.exports = function (phase, { defaultConfig }) {
        const isDev = phase === "phase-development-server";
        return {
          trailingSlash: true,
          experimental: { ppr: true },
        };
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "trailingSlash")?.status).toBe("supported");
    expect(items.find((i) => i.name === "experimental.ppr")?.status).toBe("unsupported");
  });

  it("detects options in an `export default function` config", () => {
    // `export default function (phase) {…}` parses as a FunctionDeclaration,
    // unlike the `module.exports = function (…)` (FunctionExpression) form.
    writeFile(
      "next.config.mjs",
      `export default function (phase) {
        return {
          trailingSlash: true,
          webpack: (config) => config,
          experimental: { ppr: true },
        };
      }`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "trailingSlash")?.status).toBe("supported");
    expect(items.find((i) => i.name === "webpack")?.status).toBe("unsupported");
    expect(items.find((i) => i.name === "experimental.ppr")?.status).toBe("unsupported");
  });

  it("detects options across all branches of a multi-phase function config", () => {
    // Canonical next/constants multi-phase form: the phase-specific config is in
    // an early return nested in an `if`, and the default config is the trailing
    // return. Keys from both branches should be reported.
    writeFile(
      "next.config.js",
      `const { PHASE_DEVELOPMENT_SERVER } = require("next/constants");
      module.exports = (phase, { defaultConfig }) => {
        if (phase === PHASE_DEVELOPMENT_SERVER) {
          return { trailingSlash: true, experimental: { ppr: true } };
        }
        return { webpack: (config) => config };
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "trailingSlash")?.status).toBe("supported");
    expect(items.find((i) => i.name === "experimental.ppr")?.status).toBe("unsupported");
    expect(items.find((i) => i.name === "webpack")?.status).toBe("unsupported");
  });

  it("detects options across both branches of a ternary function config", () => {
    writeFile(
      "next.config.mjs",
      `export default (phase) =>
        phase === "phase-development-server"
          ? { trailingSlash: true }
          : { basePath: "/app" };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "trailingSlash")?.status).toBe("supported");
    expect(items.find((i) => i.name === "basePath")?.status).toBe("supported");
  });

  it.each([
    ["experimental.ppr", "experimental", "ppr: true"],
    ["experimental.typedRoutes", "experimental", "typedRoutes: true"],
    ["experimental.serverActions", "experimental", "serverActions: { allowedOrigins: [] }"],
    ["experimental.prefetchInlining", "experimental", "prefetchInlining: true"],
    ["experimental.swcEnvOptions", "experimental", 'swcEnvOptions: { mode: "usage" }'],
    ["experimental.appShells", "experimental", "appShells: true"],
    ["experimental.varyParams", "experimental", "varyParams: true"],
    ["experimental.optimisticRouting", "experimental", "optimisticRouting: true"],
    ["experimental.cachedNavigations", "experimental", "cachedNavigations: true"],
    ["i18n.domains", "i18n", "domains: []"],
  ])("detects %s via generic dot-notation handling", (name, parent, body) => {
    writeFile("next.config.mjs", `export default { ${parent}: { ${body} } };`);
    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === name)).toBeDefined();
  });

  it("reads next.config.ts files", () => {
    writeFile("next.config.ts", `const config = { basePath: "/app" }; export default config;`);

    const items = analyzeConfig(tmpDir);
    expect(items.find((i) => i.name === "basePath")?.status).toBe("supported");
  });

  it("sorts unsupported configs first", () => {
    writeFile(
      "next.config.mjs",
      `export default {
        basePath: "/app",
        webpack: (config) => config,
        images: { domains: [] },
      };`,
    );

    const items = analyzeConfig(tmpDir);
    expect(items[0].status).toBe("unsupported"); // webpack
    expect(items[items.length - 1].status).toBe("supported"); // basePath
  });
});

// ── checkLibraries ─────────────────────────────────────────────────────────

describe("checkLibraries", () => {
  it("returns empty when no package.json", () => {
    const items = checkLibraries(tmpDir);
    expect(items).toHaveLength(0);
  });

  it("returns empty when no known libraries are used", () => {
    writeFile(
      "package.json",
      JSON.stringify({
        dependencies: { react: "^19.0.0", "some-lib": "^1.0.0" },
      }),
    );

    const items = checkLibraries(tmpDir);
    expect(items).toHaveLength(0);
  });

  it("detects supported libraries", () => {
    writeFile(
      "package.json",
      JSON.stringify({
        dependencies: { "next-themes": "^0.3.0", tailwindcss: "^3.0.0", zod: "^3.0.0" },
      }),
    );

    const items = checkLibraries(tmpDir);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.status === "supported")).toBe(true);
  });

  it("detects unsupported libraries", () => {
    writeFile(
      "package.json",
      JSON.stringify({
        dependencies: { "@auth/nextjs": "^5.0.0", "next-auth": "^4.0.0" },
      }),
    );

    const items = checkLibraries(tmpDir);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === "unsupported")).toBe(true);
  });

  it("detects @clerk/nextjs as partial", () => {
    writeFile(
      "package.json",
      JSON.stringify({
        dependencies: { "@clerk/nextjs": "^7.0.0" },
      }),
    );

    const items = checkLibraries(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("partial");
    expect(items[0].detail).toContain("clerkMiddleware");
  });

  it("detects supported CSS-in-JS libraries", () => {
    writeFile(
      "package.json",
      JSON.stringify({
        dependencies: { "styled-components": "^6.0.0" },
      }),
    );

    const items = checkLibraries(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("supported");
    expect(items[0].detail).toContain("useServerInsertedHTML");
  });

  it("checks both dependencies and devDependencies", () => {
    writeFile(
      "package.json",
      JSON.stringify({
        dependencies: { tailwindcss: "^3.0.0" },
        devDependencies: { prisma: "^5.0.0" },
      }),
    );

    const items = checkLibraries(tmpDir);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.name === "tailwindcss")).toBeDefined();
    expect(items.find((i) => i.name === "prisma")).toBeDefined();
  });

  it("sorts unsupported libraries first", () => {
    writeFile(
      "package.json",
      JSON.stringify({
        dependencies: {
          tailwindcss: "^3.0.0",
          "next-auth": "^4.0.0",
          "@sentry/nextjs": "^7.0.0",
        },
      }),
    );

    const items = checkLibraries(tmpDir);
    expect(items[0].status).toBe("unsupported");
    expect(items[items.length - 1].status).toBe("supported");
  });
});

// ── checkConventions ───────────────────────────────────────────────────────

describe("checkConventions", () => {
  it("detects pages directory", () => {
    writeFile("pages/index.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name === "Pages Router (pages/)")).toBeDefined();
    expect(items.find((i) => i.name.includes("1 page"))?.status).toBe("supported");
  });

  it("detects app directory", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile(
      "app/layout.tsx",
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name === "App Router (app/)")).toBeDefined();
    expect(items.find((i) => i.name.includes("1 page"))?.status).toBe("supported");
    expect(items.find((i) => i.name.includes("1 layout"))?.status).toBe("supported");
  });

  it("detects middleware.ts", () => {
    writeFile("middleware.ts", `export function middleware() {}`);

    // Also need pages or app directory
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const mw = items.find((i) => i.name.includes("middleware.ts"));
    expect(mw?.status).toBe("supported");
    expect(mw?.name).toContain("deprecated");
  });

  it("detects middleware.js", () => {
    writeFile("middleware.js", `export function middleware() {}`);
    writeFile("pages/index.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const mw = items.find((i) => i.name.includes("middleware.ts"));
    expect(mw?.status).toBe("supported");
    expect(mw?.name).toContain("deprecated");
  });

  it("detects proxy.ts (Next.js 16)", () => {
    writeFile("proxy.ts", `export default function proxy() {}`);
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const proxy = items.find((i) => i.name.includes("proxy.ts"));
    expect(proxy?.status).toBe("supported");
    expect(proxy?.name).toContain("Next.js 16");
  });

  it("prefers proxy.ts over middleware.ts in check", () => {
    writeFile("proxy.ts", `export default function proxy() {}`);
    writeFile("middleware.ts", `export function middleware() {}`);
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    // Should show proxy.ts, not middleware.ts
    expect(items.find((i) => i.name.includes("proxy.ts"))).toBeDefined();
    expect(items.find((i) => i.name.includes("middleware.ts"))).toBeUndefined();
  });

  it("detects src/app directory when app/ is not at root", () => {
    writeFile("src/app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile(
      "src/app/layout.tsx",
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name === "App Router (src/app/)")).toBeDefined();
    expect(items.find((i) => i.name.includes("1 page"))?.status).toBe("supported");
    expect(items.find((i) => i.name.includes("1 layout"))?.status).toBe("supported");
  });

  it("detects src/pages directory when pages/ is not at root", () => {
    writeFile("src/pages/index.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name === "Pages Router (src/pages/)")).toBeDefined();
    expect(items.find((i) => i.name.includes("1 page"))?.status).toBe("supported");
  });

  it("prefers root-level app/ over src/app/", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile("src/app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name === "App Router (app/)")).toBeDefined();
    // src/app/ should also be detected (both exist)
  });

  it("reports unsupported when no pages/ or app/ directory", () => {
    writeFile("src/index.ts", `console.log("hi");`);

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.status === "unsupported")).toBeDefined();
    expect(items.find((i) => i.name.includes("No pages/ or app/"))).toBeDefined();
  });

  it("counts API routes separately", () => {
    writeFile("pages/index.tsx", `export default function Home() { return <div/>; }`);
    writeFile("pages/api/hello.ts", `export default function handler(req, res) { res.json({}) }`);
    writeFile("pages/api/users.ts", `export default function handler(req, res) { res.json({}) }`);

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name.includes("2 API route"))).toBeDefined();
  });

  it("detects custom _app and _document", () => {
    writeFile("pages/index.tsx", `export default function Home() { return <div/>; }`);
    writeFile(
      "pages/_app.tsx",
      `export default function App({ Component, pageProps }) { return <Component {...pageProps} /> }`,
    );
    writeFile("pages/_document.tsx", `export default function Document() {}`);

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name === "Custom _app")?.status).toBe("supported");
    expect(items.find((i) => i.name === "Custom _document")?.status).toBe("supported");
  });

  it("detects App Router conventions (loading, error, not-found)", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile(
      "app/layout.tsx",
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );
    writeFile(
      "app/loading.tsx",
      `export default function Loading() { return <div>Loading...</div>; }`,
    );
    writeFile(
      "app/error.tsx",
      `"use client"; export default function Error() { return <div>Error</div>; }`,
    );
    writeFile(
      "app/not-found.tsx",
      `export default function NotFound() { return <div>Not Found</div>; }`,
    );

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name.includes("loading"))?.status).toBe("supported");
    expect(items.find((i) => i.name.includes("error"))?.status).toBe("supported");
    expect(items.find((i) => i.name.includes("not-found"))?.status).toBe("supported");
  });

  it("detects route handlers in App Router", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile(
      "app/api/hello/route.ts",
      `export function GET() { return Response.json({ hello: "world" }); }`,
    );

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name.includes("1 route handler"))).toBeDefined();
  });

  it("flags missing type:module in package.json", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile("package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));

    const items = checkConventions(tmpDir);
    const typeModule = items.find((i) => i.name.includes('"type": "module"'));
    expect(typeModule).toBeDefined();
    expect(typeModule?.status).toBe("unsupported");
    expect(typeModule?.detail).toContain("vinext init");
  });

  it("does not flag type:module when present", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile(
      "package.json",
      JSON.stringify({ type: "module", dependencies: { react: "^19.0.0" } }),
    );

    const items = checkConventions(tmpDir);
    const typeModule = items.find((i) => i.name.includes('"type": "module"'));
    expect(typeModule).toBeUndefined();
  });

  it("detects ViewTransition import from react", () => {
    writeFile(
      "app/page.tsx",
      `import { ViewTransition } from "react";\nexport default function Home() { return <ViewTransition><div/></ViewTransition>; }`,
    );

    const items = checkConventions(tmpDir);
    const vt = items.find((i) => i.name.includes("ViewTransition"));
    expect(vt).toBeDefined();
    expect(vt?.status).toBe("partial");
    expect(vt?.detail).toContain("passthrough fallback");
    expect(vt?.files).toHaveLength(1);
  });

  it("does not flag ViewTransition when not imported", () => {
    writeFile(
      "app/page.tsx",
      `import React from "react";\nexport default function Home() { return <div/>; }`,
    );

    const items = checkConventions(tmpDir);
    const vt = items.find((i) => i.name.includes("ViewTransition"));
    expect(vt).toBeUndefined();
  });

  it("detects PostCSS string-form plugins", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile("postcss.config.mjs", `export default {\n  plugins: ["@tailwindcss/postcss"]\n};`);

    const items = checkConventions(tmpDir);
    const postcss = items.find((i) => i.name.includes("PostCSS"));
    expect(postcss).toBeDefined();
    expect(postcss?.status).toBe("partial");
    expect(postcss?.detail).toContain("string-form");
  });

  it("does not flag PostCSS when no config exists", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const postcss = items.find((i) => i.name.includes("PostCSS"));
    expect(postcss).toBeUndefined();
  });

  it("detects multiline PostCSS string-form plugins", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile(
      "postcss.config.mjs",
      `export default {\n  plugins: [\n    "@tailwindcss/postcss",\n    "autoprefixer",\n  ],\n};`,
    );

    const items = checkConventions(tmpDir);
    const postcss = items.find((i) => i.name.includes("PostCSS"));
    expect(postcss?.status).toBe("partial");
  });

  it("does not flag require()-form PostCSS plugins", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile(
      "postcss.config.cjs",
      `module.exports = {\n  plugins: [require("@tailwindcss/postcss"), require("autoprefixer")]\n};`,
    );

    const items = checkConventions(tmpDir);
    const postcss = items.find((i) => i.name.includes("PostCSS"));
    expect(postcss).toBeUndefined();
  });

  // Regression: a very large config whose `plugins: [` array is never closed used to
  // send the old `/plugins\s*:\s*\[[\s\S]*?(['"]…['"])[\s\S]*?\]/` regex into quadratic
  // backtracking, hanging the process / overflowing the regex stack. The anchored
  // replacement runs in linear time, so this must complete near-instantly.
  it("handles a huge unterminated PostCSS plugins array without hanging", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    // ~1.2MB of quoted entries inside an array that is never closed with `]`.
    const huge = `export default {\n  plugins: [\n` + `    "plugin-x",\n`.repeat(200_000);
    writeFile("postcss.config.mjs", huge);

    const start = Date.now();
    const items = checkConventions(tmpDir);
    const elapsed = Date.now() - start;

    // The first element is a bare string, so it is still correctly flagged...
    const postcss = items.find((i) => i.name.includes("PostCSS"));
    expect(postcss?.status).toBe("partial");
    // ...and crucially it returns quickly instead of backtracking for minutes.
    expect(elapsed).toBeLessThan(2000);
  });

  // Regression: the catastrophic case for the old regex — a large array with quoted
  // tokens but no closing `]`, where the trailing `[\s\S]*?\]` forced repeated full
  // re-scans. The anchored regex resolves this in a single linear pass.
  it("handles a huge unterminated array with no leading string quickly", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    // No leading quote after `[` (require-style head) then a huge unterminated tail.
    const huge =
      `export default {\n  plugins: [\n    require("a"),\n` + `    require("x"),\n`.repeat(200_000);
    writeFile("postcss.config.mjs", huge);

    const start = Date.now();
    const items = checkConventions(tmpDir);
    const elapsed = Date.now() - start;

    // require()-style head → not flagged as string-form.
    const postcss = items.find((i) => i.name.includes("PostCSS"));
    expect(postcss).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
  });

  it("detects __dirname usage in server files", () => {
    writeFile("lib/db.ts", `import path from "path";\nconst dir = path.join(__dirname, "data");`);
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const cjs = items.find((i) => i.name.includes("__dirname"));
    expect(cjs).toBeDefined();
    expect(cjs?.status).toBe("unsupported");
    expect(cjs?.detail).toContain("fileURLToPath");
    expect(cjs?.detail).toContain("import.meta.dirname");
    expect(cjs?.files).toContain("lib/db.ts");
  });

  it("detects __filename usage", () => {
    writeFile("lib/logger.ts", `const file = __filename;`);
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const cjs = items.find((i) => i.name.includes("__dirname"));
    expect(cjs).toBeDefined();
    expect(cjs?.files).toContain("lib/logger.ts");
  });

  it("detects both __dirname and __filename in same file", () => {
    writeFile("lib/util.ts", `const dir = __dirname;\nconst file = __filename;`);
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const cjs = items.find((i) => i.name.includes("__dirname"));
    expect(cjs).toBeDefined();
    expect(cjs?.files).toContain("lib/util.ts");
    // Only one item for both globals
    expect(
      items.filter((i) => i.name.includes("__dirname") || i.name.includes("__filename")),
    ).toHaveLength(1);
  });

  it("does not flag __dirname inside string literals", () => {
    writeFile(
      "lib/comment.ts",
      `const msg = "use __dirname instead";\nexport default function Home() { return null; }`,
    );
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const cjs = items.find((i) => i.name.includes("__dirname"));
    expect(cjs).toBeUndefined();
  });

  it("does not flag __dirname inside comments", () => {
    writeFile("lib/note.ts", `// Previously used __dirname here\nexport const x = 1;`);
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const cjs = items.find((i) => i.name.includes("__dirname"));
    expect(cjs).toBeUndefined();
  });

  it("does not flag __dirname inside a plain template literal (no interpolation)", () => {
    writeFile("lib/msg.ts", "const msg = `use __dirname instead`;");
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const cjs = items.find((i) => i.name.includes("__dirname"));
    expect(cjs).toBeUndefined();
  });

  it("detects __dirname inside a template expression ${...}", () => {
    writeFile("lib/db.ts", "const dir = `${__dirname}/views`;");
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const cjs = items.find((i) => i.name.includes("__dirname"));
    expect(cjs).toBeDefined();
    expect(cjs?.files).toContain("lib/db.ts");
  });

  it("does not flag __dirname when not used at all", () => {
    writeFile(
      "lib/esm.ts",
      `import { fileURLToPath } from "url";\nimport { dirname } from "path";\nconst __dirname = dirname(fileURLToPath(import.meta.url));`,
    );
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    // The ESM pattern itself reassigns __dirname — this is fine and should not be flagged
    // because users are already using the correct ESM idiom.
    // Our scanner will see `__dirname` in the assignment target — that's an edge case we accept.
    // This test just ensures we don't crash.
    const items = checkConventions(tmpDir);
    // No assertion on presence/absence — just verify it doesn't throw
    expect(Array.isArray(items)).toBe(true);
  });

  it("tracks multiple files that use __dirname", () => {
    writeFile("lib/a.ts", `const d = __dirname;`);
    writeFile("lib/b.ts", `const f = __filename;`);
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);

    const items = checkConventions(tmpDir);
    const cjs = items.find((i) => i.name.includes("__dirname"));
    expect(cjs).toBeDefined();
    expect(cjs?.files).toHaveLength(2);
    expect(cjs?.files).toContain("lib/a.ts");
    expect(cjs?.files).toContain("lib/b.ts");
  });
});

// ── hasFreeCjsGlobal ─────────────────────────────────────────────────────────

describe("hasFreeCjsGlobal", () => {
  it("detects free __dirname / __filename in code", () => {
    expect(hasFreeCjsGlobal(`const d = __dirname;`)).toBe(true);
    expect(hasFreeCjsGlobal(`const f = __filename;`)).toBe(true);
    expect(hasFreeCjsGlobal(`path.join(__dirname, "data")`)).toBe(true);
  });

  it("ignores occurrences inside strings, comments and plain templates", () => {
    expect(hasFreeCjsGlobal(`const m = "use __dirname instead";`)).toBe(false);
    expect(hasFreeCjsGlobal(`const m = 'use __dirname instead';`)).toBe(false);
    expect(hasFreeCjsGlobal(`// previously used __dirname here`)).toBe(false);
    expect(hasFreeCjsGlobal(`/* block __dirname comment */`)).toBe(false);
    expect(hasFreeCjsGlobal("const m = `use __dirname instead`;")).toBe(false);
  });

  it("detects __dirname inside a template expression", () => {
    expect(hasFreeCjsGlobal("const dir = `${__dirname}/views`;")).toBe(true);
    // nested template inside the expression, real use deeper in
    expect(hasFreeCjsGlobal("const x = `a${ `b${__filename}c` }d`;")).toBe(true);
    // __dirname only appears in the inner plain-template text → not a free use
    expect(hasFreeCjsGlobal("const x = `a${ `__dirname` }d`;")).toBe(false);
  });

  it("does not match identifiers that merely contain the substring", () => {
    expect(hasFreeCjsGlobal(`const my__dirname = 1;`)).toBe(false);
    expect(hasFreeCjsGlobal(`const __dirnameSuffix = 1;`)).toBe(false);
  });

  it("does not let a regex literal hide a later __dirname", () => {
    // A stray quote/backtick inside a regex literal must not hijack string/template
    // state and swallow real code that follows it.
    expect(hasFreeCjsGlobal(`const r = /'/; const d = __dirname;`)).toBe(true);
    expect(hasFreeCjsGlobal("const r = /`/;\nconst d = __dirname;")).toBe(true);
    expect(hasFreeCjsGlobal("const r = /['\"`]/; const d = __filename;")).toBe(true);
    // `/` after a `return` keyword is a regex; the `__dirname` after still counts.
    expect(hasFreeCjsGlobal(`function f() { return /'/; }\nconst d = __dirname;`)).toBe(true);
  });

  it("does not treat division as a regex literal", () => {
    // `/` after a value is division, not a regex — the second operand still scans.
    expect(hasFreeCjsGlobal(`const x = a / b; const d = __dirname;`)).toBe(true);
    expect(hasFreeCjsGlobal(`const x = total / __dirname.length;`)).toBe(true);
  });

  it("ignores __dirname inside a regex literal", () => {
    expect(hasFreeCjsGlobal(`const r = /__dirname/; const x = 1;`)).toBe(false);
  });

  it("does not misread division after } or postfix ++/-- as a regex literal", () => {
    // Division after a postfix `++`/`--` or a `}` must not be parsed as a regex
    // literal (which would swallow the rest of the line and hide the __dirname).
    expect(hasFreeCjsGlobal("i++ / 2; const d = __dirname;")).toBe(true);
    expect(hasFreeCjsGlobal("i-- / 2; const d = __dirname;")).toBe(true);
    expect(hasFreeCjsGlobal("const x = {a:1} / 2; const d = __dirname;")).toBe(true);
    expect(hasFreeCjsGlobal("i++ / __dirname / b; z;")).toBe(true);
    expect(hasFreeCjsGlobal("const half = list.pop() ? a-- / 2 : 0; const root = __dirname;")).toBe(
      true,
    );
  });

  it("still parses a real regex after a prefix ++ or keyword", () => {
    // Prefix `++i` keeps operator position; the regex that follows is still a regex.
    expect(hasFreeCjsGlobal("if (++i) { return /'/; }\nconst d = __dirname;")).toBe(true);
  });

  // Known limitation (documented on hasFreeCjsGlobal): distinguishing a value-position
  // regex literal from division after `}` needs a real parser. We bias to division, so
  // a statement-start regex after a block `}` whose body has an unpaired quote can mask
  // a same-line __dirname. Accepted for an advisory check; pinned here so the gap is
  // explicit. The multi-line variant is unaffected (string scanning stops at \n).
  it("does not detect a __dirname hidden by a value-position regex on the same line", () => {
    expect(hasFreeCjsGlobal("function f(){} /'/.test(x); const d = __dirname;")).toBe(false);
  });

  it("still detects __dirname on a later line after a value-position regex", () => {
    expect(hasFreeCjsGlobal("function f(){} /'/.test(x);\nconst d = __dirname;")).toBe(true);
  });

  // Regression: the old alternation regex's `(?:[^"\\]|\\.)*` string-body loop
  // overflowed V8's regex stack ("Maximum call stack size exceeded") on very large
  // files. These inputs reproduce that; the scanner must return in linear time.
  it("handles a multi-megabyte unterminated string literal without overflowing", () => {
    const content = `const s = "` + "a".repeat(20_000_000); // ~20MB, no closing quote
    const start = Date.now();
    expect(hasFreeCjsGlobal(content)).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("handles an escape-heavy unterminated string without overflowing", () => {
    // Unrolling the regex did not help this shape — it still overflowed. The scanner does not.
    const content = `const s = "` + 'a\\"'.repeat(10_000_000); // ~30MB of escaped quotes
    const start = Date.now();
    expect(hasFreeCjsGlobal(content)).toBe(false);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("still finds a real __dirname after a huge benign string", () => {
    const content = `const s = "${"x".repeat(5_000_000)}";\nconst d = __dirname;`;
    const start = Date.now();
    expect(hasFreeCjsGlobal(content)).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

// ── runCheck ───────────────────────────────────────────────────────────────

describe("runCheck", () => {
  it("returns a complete result with all sections", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile(
      "app/layout.tsx",
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );
    writeFile(
      "package.json",
      JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }),
    );

    const result = runCheck(tmpDir);
    expect(result.imports).toBeDefined();
    expect(result.config).toBeDefined();
    expect(result.libraries).toBeDefined();
    expect(result.conventions).toBeDefined();
    expect(result.summary).toBeDefined();
  });

  it("calculates score correctly — 100% for all supported", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile(
      "app/layout.tsx",
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );
    writeFile(
      "package.json",
      JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }),
    );

    const result = runCheck(tmpDir);
    // All items should be supported: next/link, no config file, tailwindcss, App Router, 1 page, 1 layout
    expect(result.summary.unsupported).toBe(0);
    expect(result.summary.score).toBe(100);
  });

  it("calculates score correctly — partial items count 50%", () => {
    // 1 supported import (next/link) + 1 partial import (next/font/google) + no-config (supported) + 2 conventions (App Router + 1 page)
    writeFile(
      "app/page.tsx",
      `
      import Link from "next/link";
      import { GoogleFont } from "next/font/google";
    `,
    );

    const result = runCheck(tmpDir);
    expect(result.summary.partial).toBeGreaterThan(0);
    expect(result.summary.score).toBeLessThan(100);
    expect(result.summary.score).toBeGreaterThan(0);
  });

  it("calculates score correctly — unsupported items drag score down", () => {
    writeFile(
      "app/page.tsx",
      `
      import { useAmp } from "next/amp";
    `,
    );
    writeFile("next.config.mjs", `export default { webpack: (config) => config };`);
    writeFile(
      "package.json",
      JSON.stringify({ type: "module", dependencies: { "next-auth": "^4.0.0" } }),
    );

    const result = runCheck(tmpDir);
    expect(result.summary.unsupported).toBeGreaterThan(0);
    expect(result.summary.score).toBeLessThan(100);
  });

  it("reports correct totals", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile(
      "package.json",
      JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }),
    );

    const result = runCheck(tmpDir);
    const total = result.summary.supported + result.summary.partial + result.summary.unsupported;
    expect(total).toBe(result.summary.total);
  });

  it("returns 100% score for empty project with no pages or app", () => {
    // Empty project — only an unsupported "no pages/ or app/" item
    writeFile("src/index.ts", `console.log("hi");`);

    const result = runCheck(tmpDir);
    // Should have 1 unsupported item (no pages/app directory)
    expect(result.summary.unsupported).toBe(1);
    expect(result.summary.score).toBeLessThan(100);
  });

  it("calculates score correctly for src/app project", () => {
    writeFile("src/app/page.tsx", `import Link from "next/link";`);
    writeFile(
      "src/app/layout.tsx",
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );
    writeFile(
      "package.json",
      JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }),
    );

    const result = runCheck(tmpDir);
    expect(result.summary.unsupported).toBe(0);
    expect(result.summary.score).toBe(100);
  });
});

// ── formatReport ───────────────────────────────────────────────────────────

describe("formatReport", () => {
  it("produces a string with section headers", () => {
    writeFile(
      "app/page.tsx",
      `
      import Link from "next/link";
      import { GoogleFont } from "next/font/google";
    `,
    );
    writeFile(
      "package.json",
      JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }),
    );

    const result = runCheck(tmpDir);
    const report = formatReport(result);

    expect(report).toContain("vinext compatibility report");
    expect(report).toContain("Imports");
    expect(report).toContain("Libraries");
    expect(report).toContain("Project structure");
    expect(report).toContain("Overall");
    expect(report).toContain("% compatible");
  });

  it("shows issues section when there are unsupported items", () => {
    writeFile("app/page.tsx", `import { useAmp } from "next/amp";`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: {} }));

    const result = runCheck(tmpDir);
    const report = formatReport(result);

    expect(report).toContain("Issues to address");
    expect(report).toContain("next/amp");
  });

  it("lists affected files under unsupported items in issues section", () => {
    writeFile("lib/db.ts", `const dir = path.join(__dirname, "data");`);
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: {} }));

    const result = runCheck(tmpDir);
    const report = formatReport(result);

    expect(report).toContain("Issues to address");
    expect(report).toContain("__dirname");
    expect(report).toContain("lib/db.ts");
  });

  it("shows partial support section when there are partial items", () => {
    writeFile("app/page.tsx", `import { GoogleFont } from "next/font/google";`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: {} }));

    const result = runCheck(tmpDir);
    const report = formatReport(result);

    expect(report).toContain("Partial support");
    expect(report).toContain("next/font/google");
  });

  it("does not show issues section when everything is supported", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile(
      "app/layout.tsx",
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );
    writeFile(
      "package.json",
      JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }),
    );

    const result = runCheck(tmpDir);
    const report = formatReport(result);

    expect(report).not.toContain("Issues to address");
    expect(report).not.toContain("Partial support");
  });

  it("includes file count for imports", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile("app/about/page.tsx", `import Link from "next/link";`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: {} }));

    const result = runCheck(tmpDir);
    const report = formatReport(result);

    expect(report).toContain("2 files");
  });

  it("handles empty result gracefully", () => {
    const emptyResult: CheckResult = {
      imports: [],
      config: [],
      libraries: [],
      conventions: [],
      summary: { supported: 0, partial: 0, unsupported: 0, total: 0, score: 100 },
    };

    const report = formatReport(emptyResult);
    expect(report).toContain("vinext compatibility report");
    expect(report).toContain("100% compatible");
  });

  it("includes actionable next steps", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: {} }));

    const result = runCheck(tmpDir);
    const report = formatReport(result);

    expect(report).toContain("Recommended next steps");
    expect(report).toContain("vinext init");
    expect(report).toContain("Or manually");
    expect(report).toContain('"type": "module"');
    expect(report).toContain("@vitejs/plugin-react");
    expect(report).toContain("@vitejs/plugin-rsc");
    expect(report).toContain("react-server-dom-webpack");
    expect(report).toContain("vite.config.ts");
    expect(report).toContain("npx vite dev");
  });

  it("does not list App Router-only packages in manual install steps for Pages Router projects", () => {
    writeFile("pages/index.tsx", `export default function Home() { return <div />; }`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: {} }));

    const result = runCheck(tmpDir);
    const report = formatReport(result);

    expect(report).toContain("@vitejs/plugin-react");
    expect(report).not.toContain("@vitejs/plugin-rsc");
    expect(report).not.toContain("react-server-dom-webpack");
  });
});

// ── Integration: running against fixtures ──────────────────────────────────

describe("integration: pages-basic fixture", () => {
  const fixtureDir = path.resolve(import.meta.dirname, "./fixtures/pages-basic");

  it("detects Pages Router conventions", () => {
    const items = checkConventions(fixtureDir);
    expect(items.find((i) => i.name === "Pages Router (pages/)")).toBeDefined();
  });

  it("detects config options from next.config.mjs", () => {
    const items = analyzeConfig(fixtureDir);
    expect(items.find((i) => i.name === "redirects")).toBeDefined();
    expect(items.find((i) => i.name === "rewrites")).toBeDefined();
    expect(items.find((i) => i.name === "headers")).toBeDefined();
    expect(items.find((i) => i.name === "env")).toBeDefined();
  });

  it("runCheck produces a valid report", () => {
    const result = runCheck(fixtureDir);
    expect(result.summary.total).toBeGreaterThan(0);
    expect(result.summary.score).toBeGreaterThanOrEqual(0);
    expect(result.summary.score).toBeLessThanOrEqual(100);
  });
});

describe("integration: app-basic fixture", () => {
  const fixtureDir = path.resolve(import.meta.dirname, "./fixtures/app-basic");

  it("detects App Router conventions", () => {
    const items = checkConventions(fixtureDir);
    expect(items.find((i) => i.name === "App Router (app/)")).toBeDefined();
  });

  it("runCheck produces a valid report", () => {
    const result = runCheck(fixtureDir);
    expect(result.summary.total).toBeGreaterThan(0);
    expect(result.summary.score).toBeGreaterThanOrEqual(0);
    expect(result.summary.score).toBeLessThanOrEqual(100);
  });
});
