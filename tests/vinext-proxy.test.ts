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
  it.each([
    ["dev", "-p", "--port"],
    ["dev", "-H", "--host"],
    ["dev", "--hostname=localhost", "--host"],
    ["dev", "--turbopack", "no-op"],
    ["dev", "--experimental-https", "server.https"],
    ["build", "--verbose", "--debug"],
    ["build", "--prerender-all", 'prerender: { routes: "*" }'],
    ["build", "--prerender-concurrency=4", "concurrency: 4"],
    ["build", "--prerender-concurrency", "concurrency: 4"],
    ["build", "--precompress=true", "precompress: true"],
  ] as const)("explains retired %s flag %s", (command, flag, guidance) => {
    const root = createRoot();
    writeProject(root);
    const result = spawnSync(process.execPath, [CLI_PATH, command, flag], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`[vinext] ${flag.split("=", 1)[0]} is no longer supported`);
    expect(result.stderr).toContain(guidance);
    expect(result.stderr).not.toContain("Unknown option");
  });

  it("does not change native Vite command errors", () => {
    const root = createRoot();
    writeProject(root);
    const result = spawnSync("vp", ["build", "--prerender-all"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option");
    expect(result.stderr).not.toContain("[vinext]");
  });

  it.each(["dev", "build"] as const)("suggests the native Vite %s command", (command) => {
    const root = createRoot();
    const result = spawnSync(process.execPath, [CLI_PATH, command], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.stderr).toContain(`migrate from \`vinext ${command}\` to \`vite ${command}\``);
  });

  it.each(["build", "dev"] as const)(
    "preloads legacy dotenv for static config imports during %s",
    async (command) => {
      const root = createRoot();
      writeProject(root);
      write(root, ".env.staging", "CONFIG_ONLY_VALUE=from-staging\nEXPANDED=$NODE_ENV\n");
      write(
        root,
        "config-env.ts",
        `
if (process.env.CONFIG_ONLY_VALUE !== "from-staging") {
  throw new Error("missing config-time dotenv: " + process.env.CONFIG_ONLY_VALUE);
}
if (process.env.EXPANDED !== ${JSON.stringify(command === "build" ? "production" : "development")}) {
  throw new Error("wrong config-time NODE_ENV expansion: " + process.env.EXPANDED);
}
export const loaded = true;
`,
      );
      write(
        root,
        "vite.config.ts",
        `
import "./config-env.ts";
import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
export default { plugins: [vinext()] };
`,
      );
      const env = { ...process.env };
      Reflect.deleteProperty(env, "NODE_ENV");

      if (command === "build") {
        const result = spawnSync(
          process.execPath,
          [CLI_PATH, command, "--mode", "staging", "--logLevel", "silent"],
          { cwd: root, encoding: "utf-8", env },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(fs.existsSync(path.join(root, "dist/server/entry.js"))).toBe(true);
      } else {
        child = spawn(process.execPath, [CLI_PATH, command, "--mode", "staging", "--port", "0"], {
          cwd: root,
          stdio: "pipe",
          env,
        });
        const info = await waitFor(() => {
          const current = readLockfile(getLockfilePath(root));
          return current && current.port > 0 ? current : undefined;
        });
        const response = await fetch(info.appUrl);
        expect(await response.text()).toContain("proxy");
      }
    },
    120_000,
  );

  it("keeps an explicit caller NODE_ENV while expanding build dotenv", () => {
    const root = createRoot();
    writeProject(root);
    write(root, ".env.production", "EXPANDED=$NODE_ENV\n");
    write(
      root,
      "vite.config.ts",
      `
import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
if (process.env.EXPANDED !== "test") throw new Error("explicit NODE_ENV was not preserved");
export default { plugins: [vinext()] };
`,
    );

    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--logLevel", "silent"], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, NODE_ENV: "test" },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 120_000);

  it("preserves the legacy ESM config migration before Vite loads a build config", () => {
    const root = createRoot();
    writeProject(root);
    write(root, "package.json", '{"name":"legacy-project"}\n');
    write(root, "postcss.config.js", "module.exports = { plugins: {} };\n");

    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--logLevel", "silent"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))).toMatchObject({
      name: "legacy-project",
      type: "module",
    });
    expect(fs.existsSync(path.join(root, "postcss.config.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(root, "postcss.config.js"))).toBe(false);
  }, 120_000);

  it("respects an explicit CommonJS package boundary", () => {
    const root = createRoot();
    writeProject(root);
    write(root, "package.json", '{"type":"commonjs"}\n');
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--logLevel", "silent"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.error).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).type).toBe(
      "commonjs",
    );
  }, 120_000);

  it("does not rewrite a CommonJS vite.config.js or its package boundary", () => {
    const root = createRoot();
    writeProject(root, "vite.config.js");
    write(root, "package.json", '{"name":"commonjs-vite-config"}\n');
    write(root, "vite.config.js", "module.exports = { plugins: [] };\n");

    spawnSync(process.execPath, [CLI_PATH, "build", "--logLevel", "silent"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))).toEqual({
      name: "commonjs-vite-config",
    });
    expect(fs.readFileSync(path.join(root, "vite.config.js"), "utf-8")).toContain("module.exports");
  }, 120_000);

  it("does not overwrite existing .cjs configs during compatibility migration", () => {
    const root = createRoot();
    writeProject(root);
    write(root, "package.json", '{"name":"config-collision"}\n');
    write(root, "postcss.config.js", "module.exports = { plugins: {} };\n");
    write(root, "postcss.config.cjs", "module.exports = { existing: true };\n");

    spawnSync(process.execPath, [CLI_PATH, "build", "--logLevel", "silent"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(fs.readFileSync(path.join(root, "postcss.config.cjs"), "utf-8")).toContain(
      "existing: true",
    );
    expect(fs.existsSync(path.join(root, "postcss.config.js"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))).toEqual({
      name: "config-collision",
    });
  }, 120_000);

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

  it.each(["--version", "-v"])("requires config for build %s", (flag) => {
    const root = createRoot();
    const result = spawnSync(process.execPath, [CLI_PATH, "build", flag], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Vite config was found for this project");
  });

  it("does not resolve Vite from the value of a known option", () => {
    const root = createRoot();
    write(root, "vite.config.ts", "export default {};\n");
    fs.unlinkSync(path.join(root, "node_modules"));
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(other, "node_modules"),
      "junction",
    );
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--outDir", "other"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not resolve the project-local Vite CLI");
  });

  it.each(["--no-watch", "--no-minify", "--no-sourcemap", "--no-manifest", "--no-base"])(
    "keeps the config preflight for valid negated option %s",
    (option) => {
      const root = createRoot();
      const result = spawnSync(process.execPath, [CLI_PATH, "build", option], {
        cwd: root,
        encoding: "utf-8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No Vite config was found for this project");
    },
  );

  it("leaves inline-valued negations and extra positional roots to Vite", () => {
    const root = createRoot();
    for (const args of [["--no-minify=false"], ["first", "second"]]) {
      const result = spawnSync(process.execPath, [CLI_PATH, "build", ...args], {
        cwd: root,
        encoding: "utf-8",
      });
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        args.length === 1 ? "Unknown option" : "Unused args: `second`",
      );
      expect(result.stderr).not.toContain("No Vite config was found");
    }
  });

  it("leaves positional arguments after a negated boolean to Vite", () => {
    const root = createRoot();
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build", "--no-watch", "false", "project"],
      { cwd: root, encoding: "utf-8" },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unused args: `project`");
    expect(result.stderr).not.toContain("No Vite config was found");
  });

  it.each([
    { args: ["--mode"] },
    { args: ["--mode="] },
    { args: ["--mode", "--debug"] },
    { args: ["-ml", "silent"] },
    { args: ["--no-config"] },
    { args: ["--no-mode"] },
    { args: ["--no-target"] },
    { args: ["--no-configLoader"] },
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

  it("does not execute either child-local Vite when an unknown option makes the root ambiguous", () => {
    const root = createRoot();
    writeProject(path.join(root, "project"));
    writeProject(path.join(root, "value"));
    fs.unlinkSync(path.join(root, "node_modules"));
    for (const directory of ["project", "value"]) {
      fs.symlinkSync(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(root, directory, "node_modules"),
        "junction",
      );
    }
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--bogus", "value", "project"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not resolve the project-local Vite CLI");
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

  it("resolves a clustered short config option", () => {
    const root = createRoot();
    writeProject(root, "config/vite.custom.ts");
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build", "-dc", "config/vite.custom.ts", "--logLevel", "silent"],
      { cwd: root, encoding: "utf-8" },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(root, "dist/server/entry.js"))).toBe(true);
  }, 120_000);

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

  it("rejects the retired --hostname option before reaching Vite", () => {
    const root = createRoot();
    writeProject(root);
    const result = spawnSync(process.execPath, [CLI_PATH, "build", "--hostname", "127.0.0.1"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--hostname is no longer supported");
    expect(result.stderr).toContain("--host");
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

  it("does not scan for config options after the option delimiter", () => {
    const root = createRoot();
    write(root, "ignored.ts", "export default {};\n");
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "build", "--", "--config", "ignored.ts"],
      { cwd: root, encoding: "utf-8" },
    );

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

describe("vinext init", () => {
  it("configures a pnpm-locked project without running pnpm when --no-install is set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-init-no-install-"));
    roots.push(root);
    write(root, "package.json", '{"name":"init-no-install","private":true}\n');
    write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write(root, "pages/index.tsx", "export default function Page() { return null; }\n");

    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "init", "--platform=node", "--skip-check", "--no-install"],
      { cwd: root, encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "vite.config.ts"))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    expect(pkg.devDependencies).toMatchObject({ vite: "latest", "@vitejs/plugin-react": "latest" });
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
  });
});
