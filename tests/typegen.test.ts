import { describe, it, expect } from "vite-plus/test";
import { createLogger, createServer, type ViteDevServer } from "vite-plus";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vinext from "../packages/vinext/src/index.js";
import { generateRouteTypes } from "../packages/vinext/src/typegen.js";
import { toSlash } from "pathslash";

const EMPTY_PAGE = "export default function Page() { return null; }\n";
const EMPTY_LAYOUT = "export default function Layout({ children }: any) { return children; }\n";
const EMPTY_ROUTE = "export async function GET() { return Response.json({ ok: true }); }\n";

async function withTempProject<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vinext-typegen-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withPreservedFile<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const original = await readFile(filePath);
  try {
    return await run();
  } finally {
    await writeFile(filePath, original);
  }
}

async function writeProjectFile(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

async function readPackageVersion(packageJsonPath: string): Promise<string> {
  const { version } = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof version !== "string") {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }
  return version;
}

async function linkPackage(root: string, packageName: string): Promise<void> {
  const workspacePackages: Record<string, string> = {
    vinext: "../packages/vinext/package.json",
    "@vinext/types": "../packages/types/package.json",
  };
  const packageJsonPath = workspacePackages[packageName]
    ? fileURLToPath(new URL(workspacePackages[packageName], import.meta.url))
    : fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  const target = path.dirname(packageJsonPath);
  const linkPath = path.join(root, "node_modules", packageName);
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function runCommand(command: string, args: string[], cwd: string): void {
  let executable = command;
  let commandArgs = args;
  if (process.platform === "win32" && command === "pnpm") {
    executable = process.env.ComSpec ?? "cmd.exe";
    commandArgs = ["/d", "/s", "/c", command, ...args];
  }

  const result = spawnSync(executable, commandArgs, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, CI: "false" },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
}

async function typecheckConsumer(root: string, withNext: boolean): Promise<string> {
  await writeProjectFile(
    root,
    "package.json",
    JSON.stringify({
      private: true,
      dependencies: withNext ? { vinext: "*", next: "*" } : { vinext: "*" },
    }),
  );
  for (const packageName of [
    "vinext",
    "@vinext/types",
    "react",
    "vite",
    "@types/node",
    "@types/react",
  ]) {
    await linkPackage(root, packageName);
  }
  if (withNext) await linkPackage(root, "next");

  const unsupportedRootValueImport = withNext
    ? ""
    : `import next from "next";\n// @ts-expect-error vinext does not implement Next.js's bare runtime entry.\nnext();\n`;
  await writeProjectFile(
    root,
    "app/page.ts",
    `import type { Metadata, NextConfig, Route } from "next";
import type { ImageProps } from "next/image";
import type { LinkProps } from "next/link";
import getConfig from "next/config";
import { Inter } from "next/font/google";
import { useRouter, useSearchParams } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import icon from "./icon.png";
${unsupportedRootValueImport}

const metadata: Metadata = { title: "vinext" };
const config: NextConfig = { reactStrictMode: true };
const route: Route = "/";
const image: ImageProps = { src: icon, alt: "icon" };
const link: LinkProps = { href: route };
const font = Inter({ subsets: ["latin"] });
type Router = ReturnType<typeof useRouter>;
declare const router: Router;
router.bfcacheId satisfies string;
useSearchParams().get("query") satisfies string | null;
getConfig().publicRuntimeConfig satisfies Record<string, unknown>;
font.className satisfies string;
useReportWebVitals((metric) => {
  metric.rating satisfies "good" | "needs-improvement" | "poor";
});
// @ts-expect-error Metadata titles cannot be numbers.
const invalidMetadata: Metadata = { title: 42 };
// @ts-expect-error reactStrictMode is boolean or null.
const invalidConfig: NextConfig = { reactStrictMode: "yes" };
// @ts-expect-error next/image requires alt text.
const invalidImage: ImageProps = { src: icon };
// @ts-expect-error next/link requires an href.
const invalidLink: LinkProps = {};
void [metadata, config, image, link, font];
`,
  );
  await writeProjectFile(root, "app/icon.png", "not-an-image");
  await generateRouteTypes({ root });

  const tscPath = fileURLToPath(new URL("bin/tsc", import.meta.resolve("typescript/package.json")));
  const result = spawnSync(
    process.execPath,
    [
      tscPath,
      "--ignoreConfig",
      "--strict",
      "--noEmit",
      "--skipLibCheck",
      "true",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--target",
      "es2022",
      path.join(root, "next-env.d.ts"),
      path.join(root, "app/page.ts"),
    ],
    { cwd: root, encoding: "utf-8" },
  );
  if (result.error) {
    throw result.error;
  }
  return result.status === 0 ? "" : `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function eventually(run: () => Promise<void>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await run();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

describe("generateRouteTypes", () => {
  it("generates Next-compatible global route helper types from the App Router tree", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/blog/[slug]/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/docs/[...slug]/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/shop/[[...slug]]/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/api/items/[id]/route.ts", EMPTY_ROUTE);
      await writeProjectFile(root, "app/dashboard/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/dashboard/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/dashboard/@analytics/default.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/%5Fsites/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/%5Fsites/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/%5Bslug%5D/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/%5Bslug%5D/page.tsx", EMPTY_PAGE);

      const result = await generateRouteTypes({ root });
      const generated = await readFile(result.routeTypesPath, "utf-8");

      expect(result.routeTypesPath).toBe(toSlash(path.join(root, ".next/types/routes.d.ts")));
      expect(result.nextEnvPath).toBe(toSlash(path.join(root, "next-env.d.ts")));
      expect(result.nextEnvStatus).toBe("created");
      expect(generated).toContain("declare namespace VinextRouteTypes");
      expect(generated).toContain(
        'type PageRoute = "/" | "/[slug]" | "/_sites" | "/blog/[slug]" | "/dashboard" | "/docs/[...slug]" | "/shop/[[...slug]]";',
      );
      expect(generated).toContain('type LayoutRoute = "/" | "/[slug]" | "/_sites" | "/dashboard";');
      expect(generated).toContain('type RouteHandlerRoute = "/api/items/[id]";');
      expect(generated).toContain('"/[slug]": {};');
      expect(generated).toContain('"/blog/[slug]": { slug: string; };');
      expect(generated).toContain('"/docs/[...slug]": { slug: string[]; };');
      expect(generated).toContain('"/shop/[[...slug]]": { slug?: string[]; };');
      expect(generated).toContain('"/dashboard": "analytics";');
      expect(generated).toContain(
        "type PageProps<Route extends VinextRouteTypes.PageRoute = VinextRouteTypes.PageRoute>",
      );
      expect(generated).toContain("type LayoutProps<Route extends VinextRouteTypes.LayoutRoute>");
      expect(generated).toContain(
        "type RouteContext<Route extends VinextRouteTypes.RouteHandlerRoute = VinextRouteTypes.RouteHandlerRoute>",
      );
    });
  });

  it("keeps layout slots scoped to their root route group", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/(marketing)/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/(marketing)/marketing/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/(marketing)/@modal/default.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/(shop)/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/(shop)/shop/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/(shop)/@cart/default.tsx", EMPTY_PAGE);

      const { routeTypesPath } = await generateRouteTypes({ root });
      const generated = await readFile(routeTypesPath, "utf-8");

      expect(generated).toContain('type LayoutRoute = "/(marketing)" | "/(shop)";');
      expect(generated).toContain('"/(marketing)": "modal";');
      expect(generated).toContain('"/(shop)": "cart";');
      expect(generated).not.toContain('"/": "cart" | "modal";');
    });
  });

  it("maps slots to the owning layout when the slot directory has no layout", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/dashboard/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/dashboard/@analytics/default.tsx", EMPTY_PAGE);

      const { routeTypesPath } = await generateRouteTypes({ root });
      const generated = await readFile(routeTypesPath, "utf-8");

      expect(generated).toContain('type LayoutRoute = "/";');
      expect(generated).toContain('"/": "analytics";');
      expect(generated).not.toContain('"/dashboard": "analytics";');
    });
  });

  it("keeps slot-local layouts separate from their owning layout", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/@modal/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/@modal/page.tsx", EMPTY_PAGE);

      const { routeTypesPath } = await generateRouteTypes({ root });
      const generated = await readFile(routeTypesPath, "utf-8");

      expect(generated).toContain('type LayoutRoute = "/" | "/@modal";');
      expect(generated).toContain('"/": "modal";');
      expect(generated).toContain('"/@modal": never;');
    });
  });

  it("loads vinext's fallback types when Next.js is not installed", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);

      await generateRouteTypes({ root });
      const generated = await readFile(path.join(root, "next-env.d.ts"), "utf-8");

      expect(generated).toContain('import "vinext/types";');
      expect(generated).not.toContain('/// <reference types="next" />');
      expect(generated).toContain('import "./.next/types/routes.d.ts";');
      expect(generated).not.toContain('/// <reference path="./.next/types/routes.d.ts" />');
    });
  });

  it("reports whether next-env.d.ts was created, updated, or unchanged", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);

      expect((await generateRouteTypes({ root })).nextEnvStatus).toBe("created");
      expect((await generateRouteTypes({ root })).nextEnvStatus).toBe("unchanged");

      await writeProjectFile(root, "next-env.d.ts", "outdated\n");
      expect((await generateRouteTypes({ root })).nextEnvStatus).toBe("updated");
    });
  });

  it("generates Next-compatible nullable navigation hooks for hybrid apps", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "pages/index.tsx", EMPTY_PAGE);

      const { routeTypesPath } = await generateRouteTypes({ root });
      const generated = await readFile(routeTypesPath, "utf-8");

      expect(generated).toContain('declare module "next/navigation"');
      expect(generated).toContain("function useParams<");
      expect(generated).toContain(">(): T | null;");
      expect(generated).toContain("function usePathname(): string | null;");
    });
  });

  it("uses Next.js types when Next.js is installed", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "node_modules/next/package.json", '{"name":"next"}\n');
      await writeProjectFile(
        root,
        "package.json",
        '{"private":true,"dependencies":{"vinext":"*","next":"*"}}\n',
      );

      await generateRouteTypes({ root });
      const generated = await readFile(path.join(root, "next-env.d.ts"), "utf-8");

      expect(generated).toContain('/// <reference types="next" />');
      expect(generated).toContain('/// <reference types="next/image-types/global" />');
      expect(generated).toContain('import "vinext/types/augmentations";');
      expect(generated).not.toContain('import "vinext/types";');
    });
  });

  it("ignores a resolvable Next.js package that the project does not declare", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "node_modules/next/package.json", '{"name":"next"}\n');
      await writeProjectFile(
        root,
        "package.json",
        '{"private":true,"dependencies":{"vinext":"*"}}\n',
      );

      await generateRouteTypes({ root });
      const generated = await readFile(path.join(root, "next-env.d.ts"), "utf-8");

      expect(generated).toContain('import "vinext/types";');
      expect(generated).not.toContain('/// <reference types="next" />');
    });
  });

  it("type-checks next imports from the workspace fallback without Next.js", async () => {
    await withTempProject(async (root) => {
      expect(await typecheckConsumer(root, false)).toBe("");
      expect(await readFile(path.join(root, "next-env.d.ts"), "utf-8")).toContain(
        'import "vinext/types";',
      );
    });
  });

  it("installs @vinext/types transitively from packed vinext without Next.js", async () => {
    await withTempProject(async (root) => {
      const vinextReadme = path.resolve("packages/vinext/README.md");
      await withPreservedFile(vinextReadme, async () => {
        const packDir = path.join(root, "packs");
        const consumer = path.join(root, "consumer");
        await mkdir(packDir, { recursive: true });
        await mkdir(consumer, { recursive: true });

        const pnpm = "pnpm";
        runCommand(pnpm, ["pack", "--pack-destination", packDir], path.resolve("packages/types"));
        runCommand(pnpm, ["pack", "--pack-destination", packDir], path.resolve("packages/vinext"));

        const tarballs = await readdir(packDir);
        const typesTarball = tarballs.find((name) => name.startsWith("vinext-types-"));
        const vinextTarball = tarballs.find(
          (name) => name.startsWith("vinext-") && !name.startsWith("vinext-types-"),
        );
        expect(typesTarball).toBeDefined();
        expect(vinextTarball).toBeDefined();

        const typesVersion = await readPackageVersion(path.resolve("packages/types/package.json"));

        await writeProjectFile(
          consumer,
          "package.json",
          JSON.stringify({
            private: true,
            dependencies: { vinext: `file:${path.join(packDir, vinextTarball!)}` },
          }),
        );
        await writeProjectFile(
          consumer,
          ".pnpmfile.cjs",
          `module.exports = { hooks: { readPackage(pkg) {\n` +
            `  if (pkg.name === "vinext") {\n` +
            `    const declared = pkg.dependencies?.["@vinext/types"];\n` +
            `    if (declared !== ${JSON.stringify(`^${typesVersion}`)}) throw new Error("packed vinext does not declare the matching @vinext/types version");\n` +
            `    pkg.dependencies = { "@vinext/types": ${JSON.stringify(`file:${path.join(packDir, typesTarball!)}`)} };\n` +
            `    pkg.peerDependencies = {};\n` +
            `  }\n` +
            `  return pkg;\n` +
            `} } };\n`,
        );
        runCommand(pnpm, ["install", "--offline", "--ignore-scripts"], consumer);
        for (const packageName of ["@types/node", "@types/react", "@types/react-dom"]) {
          await linkPackage(consumer, packageName);
        }

        const virtualStore = path.join(consumer, "node_modules/.pnpm");
        const typesStoreEntry = (await readdir(virtualStore)).find((entry) =>
          entry.startsWith("@vinext+types@"),
        );
        expect(typesStoreEntry).toBeDefined();
        const installedTypesManifest = path.join(
          virtualStore,
          typesStoreEntry!,
          "node_modules/@vinext/types/package.json",
        );
        expect(JSON.parse(await readFile(installedTypesManifest, "utf-8"))).toMatchObject({
          name: "@vinext/types",
        });

        await writeProjectFile(
          consumer,
          "app/page.ts",
          'import type { NextConfig } from "next";\nconst config: NextConfig = {};\nvoid config;\n',
        );
        await generateRouteTypes({ root: consumer });
        expect(await readFile(path.join(consumer, "next-env.d.ts"), "utf-8")).toContain(
          'import "vinext/types";',
        );
        runCommand(
          process.execPath,
          [
            path.resolve("node_modules/typescript/bin/tsc"),
            "--ignoreConfig",
            "--strict",
            "--noEmit",
            "--module",
            "esnext",
            "--moduleResolution",
            "bundler",
            "--target",
            "esnext",
            path.join(consumer, "next-env.d.ts"),
            path.join(consumer, "app/page.ts"),
          ],
          consumer,
        );
      });
    });
  }, 30_000);

  it("continues using Next.js's own types when both packages are installed", async () => {
    await withTempProject(async (root) => {
      expect(await typecheckConsumer(root, true)).toBe("");
      const generated = await readFile(path.join(root, "next-env.d.ts"), "utf-8");
      expect(generated).toContain('/// <reference types="next" />');
      expect(generated).not.toContain('import "vinext/types";');
    });
  });

  it("switches generated next-env.d.ts between vinext and Next.js types", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(
        root,
        "package.json",
        '{"private":true,"dependencies":{"vinext":"*"}}\n',
      );

      await generateRouteTypes({ root });
      expect(await readFile(path.join(root, "next-env.d.ts"), "utf-8")).toContain(
        'import "vinext/types";',
      );

      await writeProjectFile(root, "node_modules/next/package.json", '{"name":"next"}\n');
      await writeProjectFile(
        root,
        "package.json",
        '{"private":true,"dependencies":{"vinext":"*","next":"*"}}\n',
      );
      await generateRouteTypes({ root });
      expect(await readFile(path.join(root, "next-env.d.ts"), "utf-8")).toContain(
        '/// <reference types="next" />',
      );

      await rm(path.join(root, "node_modules/next"), { recursive: true, force: true });
      await writeProjectFile(
        root,
        "package.json",
        '{"private":true,"dependencies":{"vinext":"*"}}\n',
      );
      await generateRouteTypes({ root });
      expect(await readFile(path.join(root, "next-env.d.ts"), "utf-8")).toContain(
        'import "vinext/types";',
      );
    });
  });

  it("migrates a generated Pages Router next-env.d.ts to the vinext fallback", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "pages/index.tsx", EMPTY_PAGE);
      await writeProjectFile(
        root,
        "next-env.d.ts",
        `/// <reference types="next" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/pages/api-reference/config/typescript for more information.
`,
      );

      await generateRouteTypes({ root });
      const generated = await readFile(path.join(root, "next-env.d.ts"), "utf-8");

      expect(generated).toContain('import "vinext/types";');
      expect(generated).toContain("https://nextjs.org/docs/pages/api-reference/config/typescript");
    });
  });

  // Ported from Next.js: test/development/typescript-app-type-declarations/
  // typescript-app-type-declarations.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/development/typescript-app-type-declarations/typescript-app-type-declarations.test.ts
  it("overwrites an incorrect next-env.d.ts", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      const customContent = '/// <reference types="custom" />\n';
      await writeProjectFile(root, "next-env.d.ts", customContent);

      await generateRouteTypes({ root });
      const generated = await readFile(path.join(root, "next-env.d.ts"), "utf-8");

      expect(generated).not.toBe(customContent);
      expect(generated).toContain('import "vinext/types";');
      expect(generated).toContain('import "./.next/types/routes.d.ts";');
    });
  });

  it("preserves the existing next-env.d.ts line endings", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "next-env.d.ts", "incorrect\r\ncontent\r\n");

      await generateRouteTypes({ root });
      const generated = await readFile(path.join(root, "next-env.d.ts"), "utf-8");

      expect(generated).toContain("\r\n");
      expect(generated.replaceAll("\r\n", "")).not.toContain("\n");
    });
  });

  it("updates generated route helper types when App Router files are added in dev", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);

      let server: ViteDevServer | null = null;
      try {
        // `appDir` in the vinext plugin options names the project root, not
        // the App Router directory; the plugin auto-detects `app/` (or
        // `src/app/`) under it. Pass the project root explicitly here so
        // the dev server uses the same root path for both Vite and vinext.
        server = await createServer({
          root,
          logLevel: "silent",
          plugins: [vinext({ appDir: root })],
        });

        const generatedPath = path.join(root, ".next", "types", "routes.d.ts");
        await eventually(async () => {
          expect(await readFile(generatedPath, "utf-8")).toContain('type PageRoute = "/";');
        });

        const aboutPage = path.join(root, "app/about/page.tsx");
        await writeProjectFile(root, "app/about/page.tsx", EMPTY_PAGE);
        server.watcher.emit("add", aboutPage);

        await eventually(async () => {
          expect(await readFile(generatedPath, "utf-8")).toContain(
            'type PageRoute = "/" | "/about";',
          );
        });

        const blogPage = path.join(root, "app/blog/page.tsx");
        const docsPage = path.join(root, "app/docs/page.tsx");
        await writeProjectFile(root, "app/blog/page.tsx", EMPTY_PAGE);
        await writeProjectFile(root, "app/docs/page.tsx", EMPTY_PAGE);
        server.watcher.emit("add", blogPage);
        server.watcher.emit("add", docsPage);

        await eventually(async () => {
          expect(await readFile(generatedPath, "utf-8")).toContain(
            'type PageRoute = "/" | "/about" | "/blog" | "/docs";',
          );
        });
      } finally {
        await server?.close();
      }
    });
  });

  it("does not block dev server startup when initial route type generation fails", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, ".next", "not a directory\n");
      const warnings: string[] = [];
      const logger = createLogger("silent");
      logger.warn = (message) => {
        warnings.push(message);
      };

      let server: ViteDevServer | null = null;
      try {
        server = await createServer({
          root,
          customLogger: logger,
          plugins: [vinext({ appDir: root })],
        });

        expect(server).toBeTruthy();
        await eventually(async () => {
          expect(
            warnings.some((warning) => warning.includes("Failed to regenerate route types")),
          ).toBe(true);
        });
      } finally {
        await server?.close();
      }
    });
  });
});
