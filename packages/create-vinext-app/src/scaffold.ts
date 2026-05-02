import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildInstallCommand, type PackageManager } from "./install.js";

export type ScaffoldOptions = {
  projectPath: string;
  projectName: string;
  template: "app" | "pages";
  install: boolean;
  git: boolean;
  pm: PackageManager;
  vinextVersion: string;
  /** Injectable exec for testing */
  _exec?: (cmd: string, args: string[], opts: { cwd: string }) => void;
};

function defaultExec(cmd: string, args: string[], opts: { cwd: string }): void {
  execFileSync(cmd, args, { cwd: opts.cwd, stdio: "inherit" });
}

/**
 * Sanitize project name into a valid Cloudflare Worker name.
 * Worker names: lowercase, alphanumeric, hyphens only. No leading/trailing hyphens.
 */
export function sanitizeWorkerName(name: string): string {
  // Strip scope (@org/)
  const unscoped = name.startsWith("@") ? name.split("/").pop()! : name;
  return unscoped
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * Recursively copy a directory, preserving structure.
 */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Walk the project directory, find .tmpl files, substitute variables,
 * and rename (strip .tmpl extension).
 */
function processTmplFiles(dir: string, vars: Record<string, string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processTmplFiles(fullPath, vars);
    } else if (entry.name.endsWith(".tmpl")) {
      let content = fs.readFileSync(fullPath, "utf-8");
      for (const [key, value] of Object.entries(vars)) {
        content = content.replaceAll(key, value);
      }
      const newPath = fullPath.slice(0, -5); // strip .tmpl
      fs.writeFileSync(newPath, content, "utf-8");
      fs.unlinkSync(fullPath);
    }
  }
}

export function scaffold(options: ScaffoldOptions): void {
  const { projectPath, projectName, template, install, git, pm, vinextVersion } = options;
  const exec = options._exec ?? defaultExec;

  // Create project directory
  fs.mkdirSync(projectPath, { recursive: true });

  // Copy template files
  const templateDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    template === "app" ? "app-router" : "pages-router",
  );
  copyDir(templateDir, projectPath);

  // Substitute .tmpl variables
  const workerName = sanitizeWorkerName(projectName);
  processTmplFiles(projectPath, {
    "{{PROJECT_NAME}}": projectName,
    "{{WORKER_NAME}}": workerName,
    "{{VINEXT_VERSION}}": vinextVersion,
  });

  // Rename _gitignore -> .gitignore
  const gitignoreSrc = path.join(projectPath, "_gitignore");
  const gitignoreDst = path.join(projectPath, ".gitignore");
  if (fs.existsSync(gitignoreSrc)) {
    fs.renameSync(gitignoreSrc, gitignoreDst);
  }

  // Git init
  if (git) {
    exec("git", ["init"], { cwd: projectPath });
  }

  // Install deps
  if (install) {
    const [cmd, ...args] = buildInstallCommand(pm);
    exec(cmd, args, { cwd: projectPath });
  }
}
