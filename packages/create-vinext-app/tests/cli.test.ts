import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { main, parseArgs } from "../src/index.js";
import { scaffold } from "../src/scaffold.js";

// Mock scaffold module
vi.mock("../src/scaffold.js", () => ({
  scaffold: vi.fn(),
}));

// Mock prompts module
vi.mock("../src/prompts.js", () => ({
  runPrompts: vi.fn(),
}));

const mockedScaffold = vi.mocked(scaffold);

let consoleLogs: string[];
let consoleErrors: string[];
let exitCode: number | undefined;

beforeEach(() => {
  consoleLogs = [];
  consoleErrors = [];
  exitCode = undefined;

  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleLogs.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    exitCode = (code ?? 0) as number;
    throw new Error(`process.exit(${code})`);
  });

  // Ensure stdin.isTTY is false so prompts are skipped by default in tests
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

  mockedScaffold.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseArgs (pure function)
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses positional project name", () => {
    const opts = parseArgs(["my-app"]);
    expect(opts.projectName).toBe("my-app");
  });

  it("parses --template app", () => {
    const opts = parseArgs(["--template", "app"]);
    expect(opts.template).toBe("app");
  });

  it("parses --template pages", () => {
    const opts = parseArgs(["--template", "pages"]);
    expect(opts.template).toBe("pages");
  });

  it("parses --yes / -y", () => {
    expect(parseArgs(["--yes"]).yes).toBe(true);
    expect(parseArgs(["-y"]).yes).toBe(true);
  });

  it("parses --skip-install", () => {
    expect(parseArgs(["--skip-install"]).skipInstall).toBe(true);
  });

  it("parses --no-git", () => {
    expect(parseArgs(["--no-git"]).noGit).toBe(true);
  });

  it("parses --help / -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("parses --version / -v", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("combines multiple flags", () => {
    const opts = parseArgs(["my-app", "--template", "pages", "-y", "--skip-install", "--no-git"]);
    expect(opts.projectName).toBe("my-app");
    expect(opts.template).toBe("pages");
    expect(opts.yes).toBe(true);
    expect(opts.skipInstall).toBe(true);
    expect(opts.noGit).toBe(true);
  });

  it("defaults all flags to false/undefined", () => {
    const opts = parseArgs([]);
    expect(opts.projectName).toBeUndefined();
    expect(opts.template).toBeUndefined();
    expect(opts.yes).toBe(false);
    expect(opts.skipInstall).toBe(false);
    expect(opts.noGit).toBe(false);
    expect(opts.help).toBe(false);
    expect(opts.version).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// main() integration
// ---------------------------------------------------------------------------

describe("main", () => {
  it("--help prints usage and returns", async () => {
    await main(["--help"]);
    const output = consoleLogs.join("\n");
    expect(output).toContain("create-vinext-app");
    expect(output).toContain("Usage:");
    expect(output).toContain("--template");
    expect(exitCode).toBeUndefined();
  });

  it("-h also prints help", async () => {
    await main(["-h"]);
    const output = consoleLogs.join("\n");
    expect(output).toContain("create-vinext-app");
  });

  it("--version prints version string", async () => {
    await main(["--version"]);
    expect(consoleLogs).toHaveLength(1);
    // Version should match semver pattern
    expect(consoleLogs[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("-v also prints version", async () => {
    await main(["-v"]);
    expect(consoleLogs).toHaveLength(1);
    expect(consoleLogs[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("-y skips prompts and uses defaults", async () => {
    await main(["my-app", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    const opts = mockedScaffold.mock.calls[0][0];
    expect(opts.projectName).toBe("my-app");
    expect(opts.template).toBe("app");
  });

  it("--template app sets app router", async () => {
    await main(["my-app", "--template", "app", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    expect(mockedScaffold.mock.calls[0][0].template).toBe("app");
  });

  it("--template pages sets pages router", async () => {
    await main(["my-app", "--template", "pages", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    expect(mockedScaffold.mock.calls[0][0].template).toBe("pages");
  });

  it("invalid template exits with error", async () => {
    await expect(main(["my-app", "--template", "invalid"])).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    expect(consoleErrors.join(" ")).toContain("Invalid template");
  });

  it("unknown option exits with error", async () => {
    await expect(main(["--unknown-flag"])).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    expect(consoleErrors.join(" ")).toContain("Unknown option");
  });

  it("positional arg becomes project name", async () => {
    await main(["cool-project", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    expect(mockedScaffold.mock.calls[0][0].projectName).toBe("cool-project");
  });

  it("--skip-install passes install: false to scaffold", async () => {
    await main(["my-app", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    expect(mockedScaffold.mock.calls[0][0].install).toBe(false);
  });

  it("--no-git passes git: false to scaffold", async () => {
    await main(["my-app", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    expect(mockedScaffold.mock.calls[0][0].git).toBe(false);
  });

  it("without --skip-install passes install: true", async () => {
    await main(["my-app", "-y", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    expect(mockedScaffold.mock.calls[0][0].install).toBe(true);
  });

  it("without --no-git passes git: true", async () => {
    await main(["my-app", "-y", "--skip-install"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    expect(mockedScaffold.mock.calls[0][0].git).toBe(true);
  });

  it("no TTY + no --yes uses defaults", async () => {
    // isTTY is already set to false in beforeEach
    await main(["--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    const opts = mockedScaffold.mock.calls[0][0];
    expect(opts.projectName).toBe("my-vinext-app");
    expect(opts.template).toBe("app");
  });

  it("invalid project name exits with error", async () => {
    await expect(main(["node_modules", "-y"])).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    expect(consoleErrors.join(" ")).toContain("Invalid project name");
  });

  it("'.' uses cwd basename as project name (normalized)", async () => {
    // Create an empty temp dir to act as cwd so isDirectoryEmpty passes
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dot-test-"));
    const originalCwd = process.cwd.bind(process);
    process.cwd = () => tmpDir;
    try {
      await main([".", "-y", "--skip-install", "--no-git"]);
      expect(mockedScaffold).toHaveBeenCalledOnce();
      const opts = mockedScaffold.mock.calls[0][0];
      // projectName should be the basename, normalized to lowercase
      const expectedName = path.basename(tmpDir).toLowerCase();
      expect(opts.projectName).not.toBe(".");
      expect(opts.projectName).toBe(expectedName);
      expect(opts.projectPath).toBe(tmpDir);
    } finally {
      process.cwd = originalCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes uppercase project name", async () => {
    await main(["My-App", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    expect(mockedScaffold.mock.calls[0][0].projectName).toBe("my-app");
  });

  it("extracts basename when given an absolute path", async () => {
    await main(["/tmp/some-dir/my-app", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    const opts = mockedScaffold.mock.calls[0][0];
    expect(opts.projectName).toBe("my-app");
    expect(opts.projectPath).toBe("/tmp/some-dir/my-app");
  });

  it("extracts basename when given a relative path with ./", async () => {
    await main(["./my-app", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    const opts = mockedScaffold.mock.calls[0][0];
    expect(opts.projectName).toBe("my-app");
  });

  it("extracts basename when given a relative path with ../", async () => {
    await main(["../my-app", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    const opts = mockedScaffold.mock.calls[0][0];
    expect(opts.projectName).toBe("my-app");
  });

  it("extracts basename from nested relative path", async () => {
    await main(["./nested/deep/my-app", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    const opts = mockedScaffold.mock.calls[0][0];
    expect(opts.projectName).toBe("my-app");
  });

  it("detects bare relative path as path not project name", async () => {
    await main(["projects/my-app", "-y", "--skip-install", "--no-git"]);
    expect(mockedScaffold).toHaveBeenCalledOnce();
    const opts = mockedScaffold.mock.calls[0][0];
    expect(opts.projectName).toBe("my-app");
  });

  it("'.' normalizes uppercase cwd basename", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "Vinext-Dot-Test-"));
    const originalCwd = process.cwd.bind(process);
    process.cwd = () => tmpDir;
    try {
      await main([".", "-y", "--skip-install", "--no-git"]);
      expect(mockedScaffold).toHaveBeenCalledOnce();
      const opts = mockedScaffold.mock.calls[0][0];
      // projectName should be the lowercased basename
      expect(opts.projectName).toBe(path.basename(tmpDir).toLowerCase());
      expect(opts.projectPath).toBe(tmpDir);
    } finally {
      process.cwd = originalCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prints success message after scaffolding", async () => {
    await main(["my-app", "-y", "--skip-install", "--no-git"]);
    const output = consoleLogs.join("\n");
    expect(output).toContain("Success!");
    expect(output).toContain("my-app");
    expect(output).toContain("Next steps:");
  });

  it("success message includes cd when project is in subdirectory", async () => {
    await main(["my-app", "-y", "--skip-install", "--no-git"]);
    const output = consoleLogs.join("\n");
    expect(output).toContain("cd my-app");
  });

  it("success message includes install hint when --skip-install", async () => {
    await main(["my-app", "-y", "--skip-install", "--no-git"]);
    const output = consoleLogs.join("\n");
    expect(output).toContain("install");
  });

  it("success message includes dev command", async () => {
    await main(["my-app", "-y", "--skip-install", "--no-git"]);
    const output = consoleLogs.join("\n");
    expect(output).toContain("dev");
  });
});
