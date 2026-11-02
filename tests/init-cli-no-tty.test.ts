import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createIsolatedFixture } from "./helpers.js";

const cliPath = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const fixture = path.resolve(import.meta.dirname, "fixtures/init-app-router");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Only what node needs, so the "script" case runs with no agent variables even
// when the test itself runs inside an agent.
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function runInit(args: string[], env: Record<string, string>) {
  const root = await createIsolatedFixture(fixture, "vinext-init-no-tty-");
  roots.push(root);
  // Piped stdio, as in CI or an agent's shell: neither stream is a TTY.
  const result = spawnSync(
    process.execPath,
    [cliPath, "init", "--platform=cloudflare", "--skip-check", "--no-install", ...args],
    {
      cwd: root,
      // Next.js's global declarations require NODE_ENV, which the CLI leaves unset here.
      env: { ...baseEnv(), ...env } as NodeJS.ProcessEnv,
      input: "",
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return {
    stdout: result.stdout,
    config: fs.readFileSync(path.join(root, "cloudflare.config.ts"), "utf8"),
  };
}

describe("vinext init --platform=cloudflare without a TTY", () => {
  it.each([
    ["an agent", { CLAUDECODE: "1" }],
    ["a script", {}],
  ])("falls back to no cache and no image optimization when run by %s", async (_, env) => {
    const { stdout, config } = await runInit([], env);

    expect(stdout).toContain(
      "  Used defaults for the choices not passed as flags:\n" +
        "    CDN cache: none (override with --cdn-cache=response-store, workers-cache, static-assets, or data-cache)\n" +
        "    Image optimization: none (override with --image-optimization=cloudflare-images)\n" +
        "    Pre-rendering: off (override with --prerender)\n",
    );
    expect(config).toContain("ASSETS: bindings.assets()");
    expect(config).not.toContain("IMAGES");
    expect(config).not.toContain("bindings.kv");
  });

  it("keeps explicit cache and image flags", async () => {
    const { stdout, config } = await runInit(
      ["--cdn-cache=workers-cache", "--data-cache=kv", "--image-optimization=cloudflare-images"],
      { CLAUDECODE: "1" },
    );

    expect(stdout).toContain(
      "  Used defaults for the choices not passed as flags:\n" +
        "    Pre-rendering: off (override with --prerender)\n" +
        "    Cache pre-warm during deploy: off (override with --warm-cache)\n\n",
    );
    expect(config).toContain("IMAGES: bindings.images()");
    expect(config).toContain("bindings.kv");
  });
});
