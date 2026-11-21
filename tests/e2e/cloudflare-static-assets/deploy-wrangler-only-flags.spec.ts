/**
 * `vinext-cloudflare deploy` in a cloudflare.config.ts project rejects the
 * Wrangler-only `--name` and `--config` flags instead of deploying the
 * configured Worker, and its help text offers them only in Wrangler config
 * projects.
 */
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const example = path.resolve(process.cwd(), "examples/static-assets-cache");
const wranglerFixture = path.resolve(process.cwd(), "tests/fixtures/cf-app-basic");
const cli = path.resolve(process.cwd(), "packages/cloudflare/dist/cli.js");
const execFileAsync = promisify(execFile);

async function runDeploy(args: string[], cwd = example): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "deploy", ...args], {
      cwd,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, output: stdout + stderr };
  }
}

test("rejects --name", async () => {
  const result = await runDeploy(["--name", "other-worker", "--dry-run"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain(
    "--name is not supported for cloudflare.config.ts projects. Set `name` in cloudflare.config.ts instead.",
  );
});

test("rejects --config", async () => {
  const result = await runDeploy(["--config", "wrangler.jsonc", "--dry-run"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("--config is not supported for cloudflare.config.ts projects.");
});

test("omits --name and --config from the help text", async () => {
  const result = await runDeploy(["--help"]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("--vite-config");
  expect(result.output).not.toMatch(/\s--name\b/);
  expect(result.output).not.toMatch(/\s--config\b/);
});

test("keeps --name and --config in the help text for Wrangler config projects", async () => {
  const result = await runDeploy(["--help"], wranglerFixture);
  expect(result.code).toBe(0);
  expect(result.output).toContain("--name <name>");
  expect(result.output).toContain("--config <path>");
});
