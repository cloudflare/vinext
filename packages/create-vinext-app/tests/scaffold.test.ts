import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scaffold, sanitizeWorkerName, type ScaffoldOptions } from "../src/scaffold.js";
import { createTmpDir, readFile, fileExists, readJson, noopExec } from "./helpers.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function defaultOpts(overrides: Partial<ScaffoldOptions> = {}): ScaffoldOptions {
  const { exec } = noopExec();
  return {
    projectPath: path.join(tmpDir, "my-app"),
    projectName: "my-app",
    template: "app",
    install: true,
    git: true,
    pm: "npm",
    vinextVersion: "^0.0.1",
    _exec: exec,
    ...overrides,
  };
}

/** Recursively collect all file paths relative to a root directory */
function walkDir(dir: string, root?: string): string[] {
  root ??= dir;
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, root));
    } else {
      results.push(path.relative(root, fullPath));
    }
  }
  return results;
}

describe("scaffold", () => {
  it("creates dir when not exists", () => {
    const projectPath = path.join(tmpDir, "my-app");
    scaffold(defaultOpts({ projectPath }));
    expect(fs.existsSync(projectPath)).toBe(true);
    expect(fs.statSync(projectPath).isDirectory()).toBe(true);
  });

  it("works in empty existing dir", () => {
    const projectPath = path.join(tmpDir, "my-app");
    fs.mkdirSync(projectPath, { recursive: true });
    scaffold(defaultOpts({ projectPath }));
    // Should have files from template
    expect(fileExists(projectPath, "vite.config.ts")).toBe(true);
    expect(fileExists(projectPath, "tsconfig.json")).toBe(true);
    expect(fileExists(projectPath, "package.json")).toBe(true);
  });

  it("app-router generates correct structure", () => {
    const projectPath = path.join(tmpDir, "my-app");
    scaffold(defaultOpts({ projectPath, template: "app" }));
    // App Router has app/ directory with layout and page
    expect(fileExists(projectPath, "app/page.tsx")).toBe(true);
    expect(fileExists(projectPath, "app/layout.tsx")).toBe(true);
    expect(fileExists(projectPath, "app/api/hello/route.ts")).toBe(true);
    // App Router does NOT have pages/ or worker/
    expect(fileExists(projectPath, "pages")).toBe(false);
    expect(fileExists(projectPath, "worker")).toBe(false);
  });

  it("pages-router generates correct structure", () => {
    const projectPath = path.join(tmpDir, "my-app");
    scaffold(defaultOpts({ projectPath, template: "pages" }));
    // Pages Router has pages/ directory and worker entry
    expect(fileExists(projectPath, "pages/index.tsx")).toBe(true);
    expect(fileExists(projectPath, "pages/about.tsx")).toBe(true);
    expect(fileExists(projectPath, "pages/api/hello.ts")).toBe(true);
    expect(fileExists(projectPath, "worker/index.ts")).toBe(true);
    // Pages Router does NOT have app/
    expect(fileExists(projectPath, "app")).toBe(false);
  });

  it("substitutes {{PROJECT_NAME}} in package.json", () => {
    const projectPath = path.join(tmpDir, "my-app");
    scaffold(defaultOpts({ projectPath, projectName: "cool-project" }));
    const pkg = readJson(projectPath, "package.json");
    expect(pkg.name).toBe("cool-project");
  });

  it("substitutes {{VINEXT_VERSION}} in package.json", () => {
    const projectPath = path.join(tmpDir, "my-app");
    scaffold(defaultOpts({ projectPath, vinextVersion: "^0.5.0" }));
    const pkg = readJson(projectPath, "package.json") as { dependencies: Record<string, string> };
    expect(pkg.dependencies.vinext).toBe("^0.5.0");
    expect(pkg.dependencies.vinext).not.toBe("latest");
    expect(pkg.dependencies.vinext).not.toBe("{{VINEXT_VERSION}}");
  });

  it("substitutes {{WORKER_NAME}} in wrangler.jsonc", () => {
    const projectPath = path.join(tmpDir, "my-app");
    scaffold(defaultOpts({ projectPath, projectName: "cool-project" }));
    const content = readFile(projectPath, "wrangler.jsonc");
    expect(content).toContain('"name": "cool-project"');
    expect(content).not.toContain("{{WORKER_NAME}}");
  });

  it("renames _gitignore to .gitignore", () => {
    const projectPath = path.join(tmpDir, "my-app");
    scaffold(defaultOpts({ projectPath }));
    expect(fileExists(projectPath, ".gitignore")).toBe(true);
    expect(fileExists(projectPath, "_gitignore")).toBe(false);
  });

  it("calls git init when git is true", () => {
    const projectPath = path.join(tmpDir, "my-app");
    const { exec, calls } = noopExec();
    scaffold(defaultOpts({ projectPath, git: true, _exec: exec }));
    const gitCall = calls.find((c) => c.cmd === "git");
    expect(gitCall).toBeDefined();
    expect(gitCall!.args).toEqual(["init"]);
    expect(gitCall!.cwd).toBe(projectPath);
  });

  it("calls install command when install is true", () => {
    const projectPath = path.join(tmpDir, "my-app");
    const { exec, calls } = noopExec();
    scaffold(defaultOpts({ projectPath, install: true, pm: "bun", _exec: exec }));
    const installCall = calls.find((c) => c.cmd === "bun");
    expect(installCall).toBeDefined();
    expect(installCall!.args).toEqual(["install"]);
    expect(installCall!.cwd).toBe(projectPath);
  });

  it("skips install when flagged", () => {
    const projectPath = path.join(tmpDir, "my-app");
    const { exec, calls } = noopExec();
    scaffold(defaultOpts({ projectPath, install: false, _exec: exec }));
    const installCall = calls.find(
      (c) => c.cmd === "npm" || c.cmd === "bun" || c.cmd === "pnpm" || c.cmd === "yarn",
    );
    expect(installCall).toBeUndefined();
  });

  it("skips git when flagged", () => {
    const projectPath = path.join(tmpDir, "my-app");
    const { exec, calls } = noopExec();
    scaffold(defaultOpts({ projectPath, git: false, _exec: exec }));
    const gitCall = calls.find((c) => c.cmd === "git");
    expect(gitCall).toBeUndefined();
  });

  it("handles nested paths", () => {
    const projectPath = path.join(tmpDir, "a", "b", "c", "my-app");
    scaffold(defaultOpts({ projectPath }));
    expect(fs.existsSync(projectPath)).toBe(true);
    expect(fileExists(projectPath, "package.json")).toBe(true);
    expect(fileExists(projectPath, "vite.config.ts")).toBe(true);
  });

  it("handles absolute paths", () => {
    const projectPath = path.join(tmpDir, "absolute-test");
    expect(path.isAbsolute(projectPath)).toBe(true);
    scaffold(defaultOpts({ projectPath }));
    expect(fs.existsSync(projectPath)).toBe(true);
    expect(fileExists(projectPath, "package.json")).toBe(true);
  });

  it("sanitizes scoped name for worker", () => {
    const projectPath = path.join(tmpDir, "scoped-app");
    scaffold(defaultOpts({ projectPath, projectName: "@org/my-app" }));
    const content = readFile(projectPath, "wrangler.jsonc");
    expect(content).toContain('"name": "my-app"');
    expect(content).not.toContain("@org");
  });

  it("no .tmpl files remain after scaffold", () => {
    const projectPath = path.join(tmpDir, "my-app");
    scaffold(defaultOpts({ projectPath }));
    const allFiles = walkDir(projectPath);
    const tmplFiles = allFiles.filter((f) => f.endsWith(".tmpl"));
    expect(tmplFiles).toEqual([]);
  });
});

describe("sanitizeWorkerName", () => {
  it("strips scope prefix", () => {
    expect(sanitizeWorkerName("@org/my-app")).toBe("my-app");
  });

  it("lowercases", () => {
    expect(sanitizeWorkerName("My-App")).toBe("my-app");
  });

  it("replaces invalid chars with hyphens", () => {
    expect(sanitizeWorkerName("my_cool.app")).toBe("my-cool-app");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeWorkerName("my--app")).toBe("my-app");
  });

  it("strips leading and trailing hyphens", () => {
    expect(sanitizeWorkerName("-my-app-")).toBe("my-app");
  });

  it("handles scoped name with special chars", () => {
    expect(sanitizeWorkerName("@my-org/My_Cool.App")).toBe("my-cool-app");
  });
});
