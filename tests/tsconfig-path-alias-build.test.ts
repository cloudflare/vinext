import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const tmpDirs: string[] = [];
const workerEntryPath = path
  .resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts")
  .replace(/\\/g, "/");
const cfPluginPath = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs",
);

type CloudflarePluginFactory = (opts?: {
  viteEnvironment?: { name: string; childEnvironments?: string[] };
}) => import("vite").Plugin;

function writeFixtureFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function readTextFilesRecursive(root: string): string {
  let output = "";
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output += readTextFilesRecursive(entryPath);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    output += fs.readFileSync(entryPath, "utf-8");
  }
  return output;
}

async function loadCloudflarePlugin(): Promise<CloudflarePluginFactory> {
  const { cloudflare } = (await import(pathToFileURL(cfPluginPath).href)) as {
    cloudflare: CloudflarePluginFactory;
  };
  return cloudflare;
}

function writeCloudflareAppFixture(root: string, name: string) {
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );

  writeFixtureFile(
    root,
    "package.json",
    JSON.stringify(
      {
        name,
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  writeFixtureFile(
    root,
    "wrangler.jsonc",
    `{
  "name": ${JSON.stringify(name)},
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "./worker/index.ts",
  "assets": {
    "not_found_handling": "none",
    "binding": "ASSETS"
  }
}
`,
  );
  writeFixtureFile(
    root,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          types: ["vite/client", "@vitejs/plugin-rsc/types"],
          paths: {
            "@/*": ["./*"],
          },
        },
        include: ["app", "lib", "content", "*.ts", "*.tsx"],
      },
      null,
      2,
    ),
  );
  writeFixtureFile(
    root,
    "app/layout.tsx",
    `export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
  );
  writeFixtureFile(
    root,
    "mdx-components.tsx",
    `export function useMDXComponents(components: Record<string, unknown>) {
  return components;
}
`,
  );
  writeFixtureFile(
    root,
    "worker/index.ts",
    `import handler from ${JSON.stringify(workerEntryPath)};

export default handler;
`,
  );
}

async function buildCloudflareAppFixture(root: string) {
  const cloudflare = await loadCloudflarePlugin();
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [
      vinext({ appDir: root }),
      cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
    ],
    logLevel: "silent",
  });
  await builder.buildApp();
}

describe("native Vite tsconfig paths build gaps", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands a tsconfig-aliased import.meta.glob in a bundled RSC build", async () => {
    // Vite's JavaScript import-glob path calls the plugin resolver, but the
    // bundled Rolldown import-glob plugin does not currently apply
    // resolve.tsconfigPaths to the glob's static prefix.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tsconfig-glob-gap-"));
    tmpDirs.push(root);
    writeCloudflareAppFixture(root, "vinext-tsconfig-glob-gap");
    writeFixtureFile(
      root,
      "app/page.tsx",
      `import { postCount } from "../lib/posts";

export default function HomePage() {
  return <main>posts: {postCount}</main>;
}
`,
    );
    writeFixtureFile(
      root,
      "lib/posts.ts",
      `export const posts = import.meta.glob("@/content/posts/**/*.mdx", { eager: true });
export const postCount = Object.keys(posts).length;
`,
    );
    writeFixtureFile(root, "content/posts/first.mdx", "# Glob gap sentinel\n");

    await buildCloudflareAppFixture(root);

    const buildOutput = readTextFilesRecursive(path.join(root, "dist"));
    expect(buildOutput).not.toContain('import.meta.glob("@/content/posts/**/*.mdx"');
    expect(buildOutput).toContain("Glob gap sentinel");
  }, 60_000);

  it("expands a tsconfig-aliased variable dynamic import in a bundled RSC build", async () => {
    // Vite's bundled dynamic-import-vars transform resolves the static prefix
    // internally. User resolveId hooks and resolve.tsconfigPaths do not turn
    // the aliased template into a relative pattern before analysis.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tsconfig-dynamic-gap-"));
    tmpDirs.push(root);
    writeCloudflareAppFixture(root, "vinext-tsconfig-dynamic-gap");
    writeFixtureFile(
      root,
      "app/page.tsx",
      `import { loadPost } from "../lib/load-post";

export default async function HomePage() {
  const post = await loadPost("first");
  return <main>{post.default({})}</main>;
}
`,
    );
    writeFixtureFile(
      root,
      "lib/load-post.ts",
      "export function loadPost(slug: string) {\n" +
        "  return import(`@/content/posts/${slug}.mdx`);\n" +
        "}\n",
    );
    writeFixtureFile(root, "content/posts/first.mdx", "# Dynamic import gap sentinel\n");

    await buildCloudflareAppFixture(root);

    const buildOutput = readTextFilesRecursive(path.join(root, "dist"));
    expect(buildOutput).not.toContain("@/content/posts/");
    expect(buildOutput).toContain("Dynamic import gap sentinel");
  }, 60_000);

  it("uses the nearest importer tsconfig when expanding aliased glob patterns", async () => {
    // Any fallback must preserve Vite's per-importer tsconfig discovery. A
    // root-level alias map silently expands this pattern against the wrong
    // config when a nested project overrides the same paths key.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tsconfig-nested-gap-"));
    tmpDirs.push(root);
    writeCloudflareAppFixture(root, "vinext-tsconfig-nested-gap");
    writeFixtureFile(
      root,
      "lib/tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["../content/*"] } },
        include: ["**/*.ts"],
      }),
    );
    writeFixtureFile(
      root,
      "app/page.tsx",
      `import { postCount } from "../lib/posts";

export default function HomePage() {
  return <main>nested posts: {postCount}</main>;
}
`,
    );
    writeFixtureFile(
      root,
      "lib/posts.ts",
      `export const posts = import.meta.glob("@/posts/**/*.mdx", { eager: true });
export const postCount = Object.keys(posts).length;
`,
    );
    writeFixtureFile(root, "content/posts/nested.mdx", "# Nested tsconfig gap sentinel\n");

    await buildCloudflareAppFixture(root);

    const buildOutput = readTextFilesRecursive(path.join(root, "dist"));
    expect(buildOutput).not.toContain('import.meta.glob("@/posts/**/*.mdx"');
    expect(buildOutput).toContain("Nested tsconfig gap sentinel");
  }, 60_000);

  it("compiles globbed MDX files containing frontmatter (issue #659)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-mdx-frontmatter-build-"));
    tmpDirs.push(root);
    writeCloudflareAppFixture(root, "vinext-mdx-frontmatter-test");
    writeFixtureFile(
      root,
      "app/page.tsx",
      `import { postCount } from "../lib/posts";

export default function HomePage() {
  return <main>posts: {postCount}</main>;
}
`,
    );
    writeFixtureFile(
      root,
      "lib/posts.ts",
      `export const posts = import.meta.glob("../content/posts/**/*.mdx", { eager: true });
export const postCount = Object.keys(posts).length;
`,
    );
    writeFixtureFile(
      root,
      "content/posts/second.mdx",
      `---
title: "Second Post"
date: "2025-08-20"
---

<span className="text-red-500">This is a post with frontmatter and JSX.</span>
`,
    );

    await buildCloudflareAppFixture(root);

    const buildOutput = readTextFilesRecursive(path.join(root, "dist"));
    expect(buildOutput).toContain("text-red-500");
    expect(buildOutput).not.toMatch(/^---\s*$[\s\S]*?title:/m);
  }, 60_000);
});
