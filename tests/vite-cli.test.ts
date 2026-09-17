import { describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  translateLegacyBuildArgs,
  translateLegacyDevArgs,
} from "../packages/vinext/src/vite-cli.js";

const VINEXT_CLI = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");

type ViteCliInvocation = {
  args: string[];
  prerenderAll?: string;
};

function runVinextAlias(command: "dev" | "build", args: string[]): ViteCliInvocation {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vinext-${command}-alias-`));
  const viteRoot = path.join(root, "node_modules/vite");
  const logPath = path.join(root, "vite-cli.log");

  try {
    fs.mkdirSync(viteRoot, { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "alias-test-project", private: true }),
    );
    fs.writeFileSync(
      path.join(viteRoot, "package.json"),
      JSON.stringify({
        name: "vite",
        version: "0.0.0-test",
        type: "module",
        main: "index.js",
        bin: { vite: "cli.js" },
      }),
    );
    fs.writeFileSync(path.join(viteRoot, "index.js"), "export {};\n");
    fs.writeFileSync(
      path.join(viteRoot, "cli.js"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.VITE_CLI_LOG, JSON.stringify({ args: process.argv.slice(2), prerenderAll: process.env.VINEXT_PRERENDER_ALL }));\n`,
    );

    const result = spawnSync(process.execPath, [VINEXT_CLI, command, ...args], {
      cwd: root,
      env: { ...process.env, VITE_CLI_LOG: logPath },
      encoding: "utf-8",
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(fs.readFileSync(logPath, "utf-8")) as ViteCliInvocation;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("vinext Vite CLI compatibility aliases", () => {
  it("runs `vinext dev` as `vite dev` with the same Vite arguments", () => {
    expect(runVinextAlias("dev", ["--host", "127.0.0.1", "--port", "4173"]).args).toEqual([
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "4173",
    ]);
  });

  it("runs `vinext build` as `vite build` with the same Vite arguments", () => {
    expect(runVinextAlias("build", ["--mode", "staging", "--logLevel", "silent"]).args).toEqual([
      "build",
      "--mode",
      "staging",
      "--logLevel",
      "silent",
    ]);
  });

  it("keeps `vinext build --prerender-all` as a supported compatibility flag", () => {
    const invocation = runVinextAlias("build", ["--prerender-all", "--mode", "staging"]);

    expect(invocation).toEqual({
      args: ["build", "--mode", "staging"],
      prerenderAll: "1",
    });
  });

  it("forwards Vite dev arguments and translates the legacy hostname flag", () => {
    expect(translateLegacyDevArgs(["--hostname", "0.0.0.0", "--port", "4000"])).toEqual([
      "--host",
      "0.0.0.0",
      "--port",
      "4000",
    ]);
    expect(translateLegacyDevArgs(["--hostname=dev.example", "--turbopack"])).toEqual([
      "--host=dev.example",
    ]);
  });

  it("maps legacy build-only flags to plugin lifecycle environment variables", () => {
    const result = translateLegacyBuildArgs([
      "--mode",
      "staging",
      "--prerender-all",
      "--prerender-concurrency=4",
      "--precompress",
      "--verbose",
    ]);

    expect(result.args).toEqual(["--mode", "staging"]);
    expect(result.env).toMatchObject({
      VINEXT_PRERENDER_ALL: "1",
      VINEXT_PRERENDER_CONCURRENCY: "4",
      VINEXT_PRECOMPRESS: "1",
    });
  });

  it("rejects invalid legacy prerender concurrency values before spawning Vite", () => {
    expect(() => translateLegacyBuildArgs(["--prerender-concurrency", "0"])).toThrow(
      "must be a positive integer",
    );
    expect(() => translateLegacyBuildArgs(["--prerender-concurrency"])).toThrow("requires a value");
  });
});
