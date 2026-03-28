import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const tmpDirs: string[] = [];

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

describe("App Router tsconfig path aliases in production builds", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("transforms alias-based import.meta.glob and alias-based dynamic import in Cloudflare builds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tsconfig-alias-build-"));
    tmpDirs.push(root);
    const workerEntryPath = path
      .resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts")
      .replace(/\\/g, "/");
    const cfPluginPath = path.resolve(
      import.meta.dirname,
      "./fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs",
    );
    const { cloudflare } = (await import(pathToFileURL(cfPluginPath).href)) as {
      cloudflare: (opts?: {
        viteEnvironment?: { name: string; childEnvironments?: string[] };
      }) => import("vite").Plugin;
    };

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
          name: "vinext-tsconfig-alias-build",
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
  "name": "vinext-tsconfig-alias-build",
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
      "app/page.tsx",
      `import { getGlobPostCount } from "../lib/mdx-loader";

export default function HomePage() {
  return <main>home {getGlobPostCount()}</main>;
}
`,
    );
    writeFixtureFile(
      root,
      "app/mdx-probe/page.mdx",
      `# Probe

This file exists only to trigger vinext's MDX auto-detection in the fixture.
`,
    );
    writeFixtureFile(
      root,
      "lib/mdx-loader.ts",
      `type MdxModule = {
  default: React.ComponentType;
};

export const mdxModules = import.meta.glob("@/content/posts/**/*.mdx", {
  eager: true,
}) as Record<string, MdxModule>;

export function getGlobPostCount(): number {
  return Object.keys(mdxModules).length;
}
`,
    );
    writeFixtureFile(
      root,
      "lib/mdx-dynamic.ts",
      `export async function loadDynamicPost(year: string, month: string, day: string, slug: string) {
  return await import(\`@/content/posts/\${year}/\${month}/\${day}/\${slug}/index.mdx\`);
}
`,
    );
    writeFixtureFile(
      root,
      "app/dynamic-posts/[year]/[month]/[day]/[slug]/page.tsx",
      `import { notFound } from "next/navigation";
import { loadDynamicPost } from "../../../../../../lib/mdx-dynamic";

export default async function DynamicPostPage({
  params,
}: {
  params: Promise<{ year: string; month: string; day: string; slug: string }>;
}) {
  const { year, month, day, slug } = await params;
  const mod = await loadDynamicPost(year, month, day, slug).catch(() => null);

  if (!mod) {
    notFound();
  }

  const Content = mod.default;

  return (
    <main data-testid="dynamic-post-page">
      <h1>Dynamic Post</h1>
      <Content />
    </main>
  );
}
`,
    );
    writeFixtureFile(
      root,
      "content/posts/2024/01/02/glob-post/index.mdx",
      `# Globbed-Only MDX Post

This content came from an alias-based MDX import.
`,
    );
    writeFixtureFile(
      root,
      "content/posts/2024/01/02/dynamic-post/index.mdx",
      `# Dynamic MDX Post

This content came from an alias-based dynamic MDX import.
`,
    );
    writeFixtureFile(
      root,
      "worker/index.ts",
      `import handler from ${JSON.stringify(workerEntryPath)};

export default handler;
`,
    );

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

    const buildOutput = readTextFilesRecursive(path.join(root, "dist"));
    expect(buildOutput).not.toContain('import.meta.glob("@/content/posts/**/*.mdx"');
    expect(buildOutput).not.toContain("@/content/posts/");
  }, 60_000);
});
