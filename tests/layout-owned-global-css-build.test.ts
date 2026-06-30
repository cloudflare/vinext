import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createBuilder } from "vite";
import { createLayoutOwnedGlobalCssPlugin } from "../packages/vinext/src/plugins/layout-owned-global-css.js";

const temporaryDirectories: string[] = [];
const cloudflarePagesExample = path.resolve(
  import.meta.dirname,
  "../examples/pages-router-cloudflare",
);

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function createPagesFixture(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-css-build-"));
  temporaryDirectories.push(projectDir);
  await writeFile(
    path.join(projectDir, "pages", "index.js"),
    `import "../src/shared.js";\nexport default function Home() {}\n`,
  );
  await writeFile(path.join(projectDir, "src", "shared.js"), `import "./global.css";\n`);
  await writeFile(path.join(projectDir, "src", "global.css"), `body { color: teal; }\n`);
  return projectDir;
}

async function buildPagesFixture(projectDir: string, serverEnvironmentName: string): Promise<void> {
  const pagesDir = path.join(projectDir, "pages");
  const input = path.join(pagesDir, "index.js");
  const plugin = createLayoutOwnedGlobalCssPlugin(
    () => path.join(projectDir, "app"),
    () => pagesDir,
  );
  const builder = await createBuilder({
    root: projectDir,
    configFile: false,
    logLevel: "error",
    plugins: [plugin],
    environments: {
      [serverEnvironmentName]: {
        consumer: "server",
        build: {
          ssr: true,
          outDir: `dist/${serverEnvironmentName}`,
          rolldownOptions: { input },
        },
      },
      client: {
        consumer: "client",
        build: {
          outDir: "dist/client",
          rolldownOptions: { input },
        },
      },
    },
  });

  await builder.build(builder.environments[serverEnvironmentName]);
  await builder.build(builder.environments.client);
}

async function createConditionalExportFixture(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-css-conditions-"));
  temporaryDirectories.push(projectDir);
  await writeFile(
    path.join(projectDir, "app", "layout.js"),
    `import { sharedClassName } from "../src/shared.js";\nexport default function Layout({ children }) { return { className: sharedClassName, children }; }\n`,
  );
  await writeFile(
    path.join(projectDir, "pages", "index.js"),
    `import { conditionalClassName, conditionalTarget } from "conditional-package";\nexport { conditionalTarget };\nexport default function Home() { return { className: conditionalClassName }; }\n`,
  );
  await writeFile(
    path.join(projectDir, "src", "shared.js"),
    `import "./global.css";\nexport const sharedClassName = "conditional-export-owner";\n`,
  );
  await writeFile(
    path.join(projectDir, "src", "client.js"),
    `import { sharedClassName } from "./shared.js";\ndocument.documentElement.className = sharedClassName;\n`,
  );
  await writeFile(
    path.join(projectDir, "src", "global.css"),
    `.conditional-export-owner { color: teal; }\n`,
  );
  await writeFile(
    path.join(projectDir, "node_modules", "conditional-package", "package.json"),
    JSON.stringify({
      name: "conditional-package",
      type: "module",
      exports: { ".": { workerd: "./worker.js", default: "./default.js" } },
    }),
  );
  await writeFile(
    path.join(projectDir, "node_modules", "conditional-package", "worker.js"),
    `export { sharedClassName as conditionalClassName } from "../../src/shared.js";\nexport const conditionalTarget = "workerd-conditional-export";\n`,
  );
  await writeFile(
    path.join(projectDir, "node_modules", "conditional-package", "default.js"),
    `export const conditionalClassName = "default-conditional-export";\nexport const conditionalTarget = "default-conditional-export";\n`,
  );
  return projectDir;
}

async function buildConditionalExportFixture(projectDir: string): Promise<string> {
  const appDir = path.join(projectDir, "app");
  const pagesDir = path.join(projectDir, "pages");
  const plugin = createLayoutOwnedGlobalCssPlugin(
    () => appDir,
    () => pagesDir,
  );
  const builder = await createBuilder({
    root: projectDir,
    configFile: false,
    logLevel: "error",
    plugins: [plugin],
    environments: {
      rsc: {
        consumer: "server",
        build: {
          ssr: true,
          outDir: "dist/rsc",
          rolldownOptions: { input: path.join(appDir, "layout.js") },
        },
      },
      pages_router_cloudflare: {
        consumer: "server",
        resolve: {
          conditions: ["workerd", "worker", "module", "browser"],
          noExternal: ["conditional-package"],
        },
        build: {
          ssr: true,
          outDir: "dist/pages",
          rolldownOptions: { input: path.join(pagesDir, "index.js") },
        },
      },
      client: {
        consumer: "client",
        build: {
          outDir: "dist/client",
          cssCodeSplit: false,
          rolldownOptions: { input: path.join(projectDir, "src", "client.js") },
        },
      },
    },
  });

  await builder.build(builder.environments.rsc);
  await builder.build(builder.environments.pages_router_cloudflare);
  await builder.build(builder.environments.client);

  const pagesOutputDir = path.join(projectDir, "dist", "pages");
  const pagesOutputFiles = await fs.readdir(pagesOutputDir, { recursive: true });
  const pagesJavaScriptFiles = pagesOutputFiles.filter((file) => /\.[cm]?js$/.test(file));
  const pagesJavaScript = (
    await Promise.all(
      pagesJavaScriptFiles.map((file) => fs.readFile(path.join(pagesOutputDir, file), "utf8")),
    )
  ).join("\n");
  if (!pagesJavaScript.includes("workerd-conditional-export")) {
    throw new Error(
      `Expected the Pages build to use the workerd conditional export. Emitted JavaScript: ${pagesJavaScript}`,
    );
  }
  if (pagesJavaScript.includes("default-conditional-export")) {
    throw new Error("Expected the Pages build not to use the default conditional export.");
  }

  const clientOutputDir = path.join(projectDir, "dist", "client");
  const outputFiles = await fs.readdir(clientOutputDir, { recursive: true });
  const cssFiles = outputFiles.filter((file) => file.endsWith(".css"));
  if (cssFiles.length === 0) {
    throw new Error(
      `Expected the client build to emit CSS. Emitted files: ${outputFiles.join(", ")}`,
    );
  }
  const cssContents = await Promise.all(
    cssFiles.map((file) => fs.readFile(path.join(clientOutputDir, file), "utf8")),
  );
  return cssContents.join("\n");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("layout-owned global CSS production builds", () => {
  it("resolves Pages imports through the plain SSR build environment", async () => {
    const projectDir = await createPagesFixture();

    await expect(buildPagesFixture(projectDir, "ssr")).resolves.toBeUndefined();
  });

  it("resolves Pages imports through a Cloudflare-style named server environment", async () => {
    const projectDir = await createPagesFixture();

    await expect(buildPagesFixture(projectDir, "pages_router_cloudflare")).resolves.toBeUndefined();
  });

  it("uses Cloudflare server conditions when scanning Pages consumers", async () => {
    const projectDir = await createConditionalExportFixture();

    await expect(buildConditionalExportFixture(projectDir)).resolves.toContain(
      ".conditional-export-owner",
    );
  });

  it("completes the actual Cloudflare Pages Router production build", async () => {
    await fs.rm(path.join(cloudflarePagesExample, "dist"), { recursive: true, force: true });

    expect(() =>
      execFileSync("vp", ["build"], {
        cwd: cloudflarePagesExample,
        stdio: "pipe",
        timeout: 30_000,
      }),
    ).not.toThrow();

    await expect(
      fs.stat(path.join(cloudflarePagesExample, "dist", "client", ".vite", "manifest.json")),
    ).resolves.toBeDefined();
  });
});
