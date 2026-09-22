import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { getLockfilePath, readLockfile } from "../packages/vinext/src/server/dev-lockfile.js";

const CLI_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const VINEXT_ENTRY_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js"),
).href;
const roots: string[] = [];
let child: ChildProcess | undefined;

function createRoot(prefix = "vinext-proxy-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  return root;
}

function write(root: string, file: string, contents: string): void {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function writeProject(root: string, configPath = "vite.config.ts"): void {
  write(root, "package.json", '{"type":"module"}\n');
  write(root, "pages/index.tsx", "export default function Page() { return <main>proxy</main>; }\n");
  write(
    root,
    configPath,
    `import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};\nexport default { plugins: [vinext()] };\n`,
  );
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for vinext proxy state");
}

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  child = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("thin vinext command proxies", () => {
  it("fails configless commands with an actionable init error", () => {
    const root = createRoot();
    const result = spawnSync(process.execPath, [CLI_PATH, "build"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Vite config was found for this project");
    expect(result.stderr).toContain("Run `vinext init`");
  });

  it.each(["--help", "--help=true"])("delegates %s to Vite without requiring a config", (flag) => {
    const root = createRoot();
    const result = spawnSync(process.execPath, [CLI_PATH, "build", flag], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--outDir");
  });

  it("honors an explicit false help value", () => {
    const root = createRoot();
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--help", "false"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Vite config was found for this project");
  });

  it("keeps the config preflight for negated boolean options", () => {
    const root = createRoot();
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--no-watch"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Vite config was found for this project");
  });

  it.each([
    { args: ["--mode"] },
    { args: ["--mode="] },
    { args: ["--mode", "--debug"] },
    { args: ["-ml", "silent"] },
  ])("lets Vite reject missing option values ($args)", ({ args }) => {
    const root = createRoot();
    const result = spawnSync(process.execPath, [CLI_PATH, "build", ...args], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("value is missing");
    expect(result.stderr).not.toContain("No Vite config was found");
  });

  it.each([
    ["build", ["--host", "127.0.0.1"], "host"],
    ["dev", ["--outDir", "dist"], "outDir"],
  ] as const)("lets Vite reject %s options from the other command", (command, args, option) => {
    const root = createRoot();
    const result = spawnSync(process.execPath, [CLI_PATH, command, ...args], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(`Unknown option \`--${option}\``);
    expect(result.stderr).not.toContain("No Vite config was found");
  });

  it("resolves child-local Vite when an invalid option precedes the project root", () => {
    const root = createRoot();
    writeProject(path.join(root, "project"));
    fs.unlinkSync(path.join(root, "node_modules"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "project/node_modules"),
      "junction",
    );
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build", "--host", "127.0.0.1", "project"],
      { cwd: root, encoding: "utf-8" },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown option `--host`");
    expect(result.stderr).not.toContain("Could not resolve the project-local Vite CLI");
  });

  it("resolves child-local Vite after an unknown valued option", () => {
    const root = createRoot();
    writeProject(path.join(root, "project"));
    fs.unlinkSync(path.join(root, "node_modules"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "project/node_modules"),
      "junction",
    );
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--bogus", "value", "project"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown option `--bogus`");
    expect(result.stderr).not.toContain("Could not resolve the project-local Vite CLI");
  });

  it("does not mask an invalid option after a configless project root", () => {
    const root = createRoot();
    write(path.join(root, "project"), "package.json", '{"type":"module"}\n');
    fs.unlinkSync(path.join(root, "node_modules"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "project/node_modules"),
      "junction",
    );
    const result = spawnSync(process.execPath, [CLI_PATH, "dev", "project", "--outDir", "dist"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown option `--outDir`");
    expect(result.stderr).not.toContain("No Vite config was found");
  });

  it("resolves project-local Vite when help precedes the root", () => {
    const root = createRoot();
    writeProject(path.join(root, "project"));
    fs.unlinkSync(path.join(root, "node_modules"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "project/node_modules"),
      "junction",
    );
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--help", "project"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("supports a positional project root", () => {
    const root = createRoot();
    writeProject(path.join(root, "project"));
    fs.unlinkSync(path.join(root, "node_modules"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "project/node_modules"),
      "junction",
    );
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build", "project", "--logLevel", "silent"],
      {
        cwd: root,
        encoding: "utf-8",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(root, "project/dist/server/entry.js"))).toBe(true);
  }, 120_000);

  it("supports Vite options before a positional project root", () => {
    const root = createRoot();
    writeProject(path.join(root, "project"));
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build", "--mode", "production", "project", "--logLevel", "silent"],
      {
        cwd: root,
        encoding: "utf-8",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(root, "project/dist/server/entry.js"))).toBe(true);
  }, 120_000);

  it.each(["--profile", "--debug"])(
    "does not consume another option as the value of optional flag %s",
    (optionalFlag) => {
      const root = createRoot();
      writeProject(path.join(root, "project"));
      const result = spawnSync(
        process.execPath,
        [
          CLI_PATH,
          "build",
          optionalFlag,
          "--mode",
          "production",
          "project",
          "--logLevel",
          "silent",
        ],
        { cwd: root, encoding: "utf-8" },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(path.join(root, "project/dist/server/entry.js"))).toBe(true);
    },
    120_000,
  );

  it.each(["--config=config/vite.custom.ts", "-c=config/vite.custom.ts"])(
    "resolves explicit config paths from the invocation cwd (%s)",
    (configArg) => {
      const root = createRoot();
      writeProject(root, "config/vite.custom.ts");
      const result = spawnSync(
        process.execPath,
        [CLI_PATH, "build", configArg, "--logLevel", "silent"],
        { cwd: root, encoding: "utf-8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(root, "dist/server/entry.js"))).toBe(true);
    },
    120_000,
  );

  it("leaves duplicate config precedence to Vite", () => {
    const root = createRoot();
    writeProject(root);
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build", "--config", "missing.ts", "-c", "vite.config.ts"],
      { cwd: root, encoding: "utf-8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing.ts");
    expect(result.stderr).not.toContain("No Vite config was found");
  });

  it("leaves unknown valued option handling to Vite", () => {
    const root = createRoot();
    writeProject(root);
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--hostname", "127.0.0.1"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown option");
    expect(result.stderr).not.toContain("No Vite config was found");
  });

  it("does not treat arguments after the option delimiter as a project root", () => {
    const root = createRoot();
    writeProject(path.join(root, "project"));
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--", "project"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Vite config was found");
  });

  it("serves configured projects and forwards termination to Vite", async () => {
    const root = createRoot();
    writeProject(root);
    child = spawn(process.execPath, [CLI_PATH, "dev", "--port", "0", "--clearScreen", "false"], {
      cwd: root,
      stdio: "pipe",
    });

    const info = await waitFor(() => {
      const current = readLockfile(getLockfilePath(root));
      return current && current.port > 0 ? current : undefined;
    });
    const response = await fetch(info.appUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("proxy");

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child!.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    child.kill("SIGTERM");
    const result = await exited;
    child = undefined;

    expect(result.signal === "SIGTERM" || result.code === 0 || result.code === 143).toBe(true);
    await waitFor(() => (fs.existsSync(getLockfilePath(root)) ? undefined : true));
  }, 60_000);
});
