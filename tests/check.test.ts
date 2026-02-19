import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanImports,
  analyzeConfig,
  checkLibraries,
  checkConventions,
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
    writeFile("app/page.tsx", `
      import Link from "next/link";
      import Image from "next/image";
    `);

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
    expect(items[0].status).toBe("partial");
    expect(items[0].detail).toContain("font.className works");
    expect(items[0].detail).toContain("font.variable mode broken");
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

  it("recognizes `import { Metadata } from 'next'` as supported", () => {
    writeFile("app/layout.tsx", `import { Metadata } from "next";\nexport const metadata: Metadata = { title: "App" };`);

    const items = scanImports(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("next");
    expect(items[0].status).toBe("supported");
  });

  it("skips `import type` statements entirely", () => {
    writeFile("app/page.tsx", `import type { Metadata } from "next";\nimport Link from "next/link";`);

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
    writeFile("app/page.tsx", `
      import Link from "next/link";
      import { GoogleFont } from "next/font/google";
      import { useAmp } from "next/amp";
    `);

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
    writeFile("app/page.tsx", `
      import Link from "next/link";
      import Link from "next/link";
    `);

    const items = scanImports(tmpDir);
    const linkItem = items.find((i) => i.name === "next/link");
    expect(linkItem?.files).toHaveLength(1);
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
    expect(items.find((i) => i.name === "reactStrictMode")?.status).toBe("supported");
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

  it("detects i18n.domains as unsupported", () => {
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
    expect(items.find((i) => i.name === "i18n.domains")?.status).toBe("unsupported");
  });

  it("reads next.config.ts files", () => {
    writeFile(
      "next.config.ts",
      `const config = { basePath: "/app" }; export default config;`,
    );

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
        dependencies: { "@clerk/nextjs": "^5.0.0", "next-auth": "^4.0.0" },
      }),
    );

    const items = checkLibraries(tmpDir);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === "unsupported")).toBe(true);
  });

  it("detects partial libraries", () => {
    writeFile(
      "package.json",
      JSON.stringify({
        dependencies: { "styled-components": "^6.0.0" },
      }),
    );

    const items = checkLibraries(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("partial");
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
    writeFile("app/layout.tsx", `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`);

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
    writeFile("src/app/layout.tsx", `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`);

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
    writeFile("pages/_app.tsx", `export default function App({ Component, pageProps }) { return <Component {...pageProps} /> }`);
    writeFile("pages/_document.tsx", `export default function Document() {}`);

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name === "Custom _app")?.status).toBe("supported");
    expect(items.find((i) => i.name === "Custom _document")?.status).toBe("supported");
  });

  it("detects App Router conventions (loading, error, not-found)", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile("app/layout.tsx", `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`);
    writeFile("app/loading.tsx", `export default function Loading() { return <div>Loading...</div>; }`);
    writeFile("app/error.tsx", `"use client"; export default function Error() { return <div>Error</div>; }`);
    writeFile("app/not-found.tsx", `export default function NotFound() { return <div>Not Found</div>; }`);

    const items = checkConventions(tmpDir);
    expect(items.find((i) => i.name.includes("loading"))?.status).toBe("supported");
    expect(items.find((i) => i.name.includes("error"))?.status).toBe("supported");
    expect(items.find((i) => i.name.includes("not-found"))?.status).toBe("supported");
  });

  it("detects route handlers in App Router", () => {
    writeFile("app/page.tsx", `export default function Home() { return <div/>; }`);
    writeFile("app/api/hello/route.ts", `export function GET() { return Response.json({ hello: "world" }); }`);

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
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: { react: "^19.0.0" } }));

    const items = checkConventions(tmpDir);
    const typeModule = items.find((i) => i.name.includes('"type": "module"'));
    expect(typeModule).toBeUndefined();
  });

  it("detects ViewTransition import from react", () => {
    writeFile("app/page.tsx", `import { ViewTransition } from "react";\nexport default function Home() { return <ViewTransition><div/></ViewTransition>; }`);

    const items = checkConventions(tmpDir);
    const vt = items.find((i) => i.name.includes("ViewTransition"));
    expect(vt).toBeDefined();
    expect(vt?.status).toBe("partial");
    expect(vt?.detail).toContain("passthrough fallback");
    expect(vt?.files).toHaveLength(1);
  });

  it("does not flag ViewTransition when not imported", () => {
    writeFile("app/page.tsx", `import React from "react";\nexport default function Home() { return <div/>; }`);

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
});

// ── runCheck ───────────────────────────────────────────────────────────────

describe("runCheck", () => {
  it("returns a complete result with all sections", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile("app/layout.tsx", `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }));

    const result = runCheck(tmpDir);
    expect(result.imports).toBeDefined();
    expect(result.config).toBeDefined();
    expect(result.libraries).toBeDefined();
    expect(result.conventions).toBeDefined();
    expect(result.summary).toBeDefined();
  });

  it("calculates score correctly — 100% for all supported", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile("app/layout.tsx", `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }));

    const result = runCheck(tmpDir);
    // All items should be supported: next/link, no config file, tailwindcss, App Router, 1 page, 1 layout
    expect(result.summary.unsupported).toBe(0);
    expect(result.summary.score).toBe(100);
  });

  it("calculates score correctly — partial items count 50%", () => {
    // 1 supported import (next/link) + 1 partial import (next/font/google) + no-config (supported) + 2 conventions (App Router + 1 page)
    writeFile("app/page.tsx", `
      import Link from "next/link";
      import { GoogleFont } from "next/font/google";
    `);

    const result = runCheck(tmpDir);
    expect(result.summary.partial).toBeGreaterThan(0);
    expect(result.summary.score).toBeLessThan(100);
    expect(result.summary.score).toBeGreaterThan(0);
  });

  it("calculates score correctly — unsupported items drag score down", () => {
    writeFile("app/page.tsx", `
      import { useAmp } from "next/amp";
    `);
    writeFile(
      "next.config.mjs",
      `export default { webpack: (config) => config };`,
    );
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: { "next-auth": "^4.0.0" } }));

    const result = runCheck(tmpDir);
    expect(result.summary.unsupported).toBeGreaterThan(0);
    expect(result.summary.score).toBeLessThan(100);
  });

  it("reports correct totals", () => {
    writeFile("app/page.tsx", `import Link from "next/link";`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }));

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
    writeFile("src/app/layout.tsx", `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }));

    const result = runCheck(tmpDir);
    expect(result.summary.unsupported).toBe(0);
    expect(result.summary.score).toBe(100);
  });
});

// ── formatReport ───────────────────────────────────────────────────────────

describe("formatReport", () => {
  it("produces a string with section headers", () => {
    writeFile("app/page.tsx", `
      import Link from "next/link";
      import { GoogleFont } from "next/font/google";
    `);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }));

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
    writeFile("app/layout.tsx", `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`);
    writeFile("package.json", JSON.stringify({ type: "module", dependencies: { tailwindcss: "^3.0.0" } }));

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
    expect(report).toContain("vite.config.ts");
    expect(report).toContain("npx vite dev");
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
