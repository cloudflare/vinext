import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const CLI_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const VINEXT_ENTRY_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js"),
).href;
const temporaryProjects: string[] = [];

function write(root: string, file: string, contents: string): void {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function createHybridProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-vite-command-contract-"));
  temporaryProjects.push(root);
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  write(root, "package.json", '{"type":"module"}\n');
  write(
    root,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};

export default defineConfig({
  plugins: [
    {
      name: "contract:config-only",
      config() {
        return { define: { __CONFIG_ONLY_MARKER__: JSON.stringify("config-only-plugin-ran") } };
      },
    },
    vinext({
      clientOutDir: "custom/client",
      rscOutDir: "custom/server",
      ssrOutDir: "custom/server/ssr",
    }),
  ],
});
`,
  );
  write(
    root,
    "app/layout.tsx",
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  write(
    root,
    "app/page.tsx",
    `export default function Page() {
  return <p>{process.env.NODE_ENV === "production" ? "vinext-production-marker" : "vinext-development-marker"}</p>;
}
`,
  );
  write(
    root,
    "pages/legacy.tsx",
    `declare const __CONFIG_ONLY_MARKER__: string;
export default function LegacyPage() {
  return <p>{__CONFIG_ONLY_MARKER__}</p>;
}
`,
  );
  return root;
}

afterEach(() => {
  for (const project of temporaryProjects.splice(0)) {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

describe("configured vinext build contract", () => {
  it("keeps hybrid config plugins, custom output roots, and production semantics", () => {
    const root = createHybridProject();

    execFileSync(process.execPath, [CLI_PATH, "build"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "development" },
      stdio: "pipe",
    });

    expect(fs.existsSync(path.join(root, "custom/server/index.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "custom/server/ssr/index.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/client"))).toBe(true);

    const pagesEntry = fs.readFileSync(path.join(root, "dist/server/entry.js"), "utf-8");
    expect(pagesEntry).toContain("config-only-plugin-ran");
    expect(pagesEntry).not.toContain("__CONFIG_ONLY_MARKER__");

    const appOutput = fs
      .globSync("**/*.js", { cwd: path.join(root, "custom/server") })
      .map((file) => fs.readFileSync(path.join(root, "custom/server", file), "utf-8"))
      .join("\n");
    expect(appOutput).toContain("vinext-production-marker");
    expect(appOutput).not.toContain("vinext-development-marker");
  }, 120_000);
});
