import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { collectDevCssHrefsForFiles } from "../packages/vinext/src/server/dev-css-imports.js";

describe("dev CSS import discovery", () => {
  it("collects static CSS imports from TSX source without matching comments or strings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dev-css-"));
    try {
      const appDir = path.join(root, "src", "app");
      await fs.mkdir(appDir, { recursive: true });
      const layoutPath = path.join(appDir, "layout.tsx");
      await fs.writeFile(
        layoutPath,
        `import "#/app/globals.css";
import styles from "./card.module.css?used";
export { default as theme } from "./theme.module.css";
import "./skip.css?raw";

const ignored = "import './string.css'";
// import "./comment.css";
/* import "./block.css"; */

export default function Layout({ children }: { children: React.ReactNode }) {
  return <main className={styles.card}>{children}</main>;
}
`,
      );

      const hrefs = await collectDevCssHrefsForFiles([layoutPath], {
        projectRoot: root,
        aliases: { "#": path.join(root, "src") },
      });

      expect(hrefs).toEqual([
        "/src/app/globals.css",
        "/src/app/card.module.css?used",
        "/src/app/theme.module.css",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("uses the resolver fallback for bare package CSS", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dev-css-"));
    try {
      const appDir = path.join(root, "app");
      const packageDir = path.join(root, "node_modules", "pkg");
      await fs.mkdir(appDir, { recursive: true });
      await fs.mkdir(packageDir, { recursive: true });
      const pagePath = path.join(appDir, "page.tsx");
      const cssPath = path.join(packageDir, "styles.css");
      await fs.writeFile(pagePath, `import "pkg/styles.css";\nexport default function Page() {}`);
      await fs.writeFile(cssPath, `.pkg { color: red; }`);

      const hrefs = await collectDevCssHrefsForFiles([pagePath], {
        projectRoot: root,
        aliases: {},
        async resolve(specifier) {
          return specifier === "pkg/styles.css" ? cssPath : null;
        },
      });

      expect(hrefs).toEqual(["/node_modules/pkg/styles.css"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("walks static source imports to discover transitive CSS imports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dev-css-"));
    try {
      const appDir = path.join(root, "src", "app");
      await fs.mkdir(appDir, { recursive: true });
      const layoutPath = path.join(appDir, "layout.tsx");
      const shellPath = path.join(appDir, "Shell.tsx");
      await fs.writeFile(layoutPath, `import Shell from "./Shell";\nexport default Shell;`);
      await fs.writeFile(shellPath, `import "./shell.css";\nexport default function Shell() {}`);
      await fs.writeFile(path.join(appDir, "shell.css"), `.shell { color: red; }`);

      const hrefs = await collectDevCssHrefsForFiles([layoutPath], {
        projectRoot: root,
        aliases: {},
      });

      expect(hrefs).toEqual(["/src/app/shell.css"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not recurse forever through circular source imports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dev-css-"));
    try {
      const appDir = path.join(root, "src", "app");
      await fs.mkdir(appDir, { recursive: true });
      const pagePath = path.join(appDir, "page.tsx");
      const shellPath = path.join(appDir, "Shell.tsx");
      await fs.writeFile(
        pagePath,
        `import Shell from "./Shell";\nimport "./page.css";\nexport default Shell;`,
      );
      await fs.writeFile(
        shellPath,
        `import Page from "./page";\nimport "./shell.css";\nexport default Page;`,
      );
      await fs.writeFile(path.join(appDir, "page.css"), `.page { color: red; }`);
      await fs.writeFile(path.join(appDir, "shell.css"), `.shell { color: blue; }`);

      const hrefs = await collectDevCssHrefsForFiles([pagePath], {
        projectRoot: root,
        aliases: {},
      });

      expect(hrefs).toEqual(["/src/app/page.css", "/src/app/shell.css"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not walk resolved package source graphs from bare imports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dev-css-"));
    try {
      const appDir = path.join(root, "app");
      const packageDir = path.join(root, "node_modules", "pkg");
      await fs.mkdir(appDir, { recursive: true });
      await fs.mkdir(packageDir, { recursive: true });
      const pagePath = path.join(appDir, "page.tsx");
      const packageEntryPath = path.join(packageDir, "index.js");
      await fs.writeFile(pagePath, `import "pkg";\nexport default function Page() {}`);
      await fs.writeFile(packageEntryPath, `import "./package.css";`);
      await fs.writeFile(path.join(packageDir, "package.css"), `.pkg { color: red; }`);

      const hrefs = await collectDevCssHrefsForFiles([pagePath], {
        projectRoot: root,
        aliases: {},
        async resolve(specifier) {
          return specifier === "pkg" ? packageEntryPath : null;
        },
      });

      expect(hrefs).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not walk special raw/url/inline source imports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dev-css-"));
    try {
      const appDir = path.join(root, "src", "app");
      await fs.mkdir(appDir, { recursive: true });
      const pagePath = path.join(appDir, "page.tsx");
      await fs.writeFile(
        pagePath,
        `import source from "./source.ts?raw";\nexport default function Page() { return source; }`,
      );
      await fs.writeFile(path.join(appDir, "source.ts"), `import "./leaked.css";`);
      await fs.writeFile(path.join(appDir, "leaked.css"), `.leaked { color: red; }`);

      const hrefs = await collectDevCssHrefsForFiles([pagePath], {
        projectRoot: root,
        aliases: {},
      });

      expect(hrefs).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("skips files that cannot be parsed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dev-css-"));
    try {
      const appDir = path.join(root, "app");
      await fs.mkdir(appDir, { recursive: true });
      const pagePath = path.join(appDir, "page.tsx");
      const onParseError = vi.fn();
      await fs.writeFile(pagePath, `import "./page.css";\nconst broken = ;`);

      const hrefs = await collectDevCssHrefsForFiles([pagePath], {
        projectRoot: root,
        aliases: {},
        onParseError,
      });

      expect(hrefs).toEqual([]);
      expect(onParseError).toHaveBeenCalledWith(pagePath, expect.anything());
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("emits /@fs hrefs for resolved CSS outside the project root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dev-css-"));
    const workspacePackageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ui-package-"));
    try {
      const appDir = path.join(root, "app");
      await fs.mkdir(appDir, { recursive: true });
      const pagePath = path.join(appDir, "page.tsx");
      const cssPath = path.join(workspacePackageRoot, "styles.css");
      await fs.writeFile(
        pagePath,
        `import "@acme/ui/styles.css";\nexport default function Page() {}`,
      );
      await fs.writeFile(cssPath, `.ui { color: red; }`);

      const hrefs = await collectDevCssHrefsForFiles([pagePath], {
        projectRoot: root,
        aliases: {},
        async resolve(specifier) {
          return specifier === "@acme/ui/styles.css" ? cssPath : null;
        },
      });

      expect(hrefs).toEqual([`/@fs/${cssPath}`]);
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
        fs.rm(workspacePackageRoot, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        }),
      ]);
    }
  });
});
