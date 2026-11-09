import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "../fixtures";

// `vinext-cloudflare deploy --vite-config` (#4198) on a copy of cf-app-basic
// whose root vite.config.ts belongs to another tool. The real CLI builds the
// app; only the Wrangler upload is replaced, and the built Worker is then
// served with the real `wrangler dev`.
const FIXTURE_DIR = path.resolve("tests/fixtures/cf-app-basic");
const CLI_PATH = path.resolve("packages/cloudflare/dist/cli.js");
const PORT = 4227;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DEPLOYED_URL = "https://cf-app-basic.example.workers.dev";

const execFileAsync = promisify(execFile);

let root: string;
let worker: ChildProcess | undefined;

async function createProject(): Promise<string> {
  // The CLI resolves paths from its real cwd (/private/var on macOS).
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "vinext-deploy-vite-config-")),
  );
  await fs.cp(FIXTURE_DIR, dir, {
    recursive: true,
    filter: (src) => !/[\\/](?:node_modules|dist|\.wrangler)(?:[\\/]|$)/.test(src),
  });

  // Link the fixture's installed packages, except Wrangler: its stand-in
  // records the deploy arguments instead of uploading the Worker.
  const fixtureModules = path.join(FIXTURE_DIR, "node_modules");
  await fs.mkdir(path.join(dir, "node_modules/wrangler/bin"), { recursive: true });
  for (const entry of await fs.readdir(fixtureModules)) {
    if (entry === "wrangler" || entry === ".bin") continue;
    const target = await fs.realpath(path.join(fixtureModules, entry));
    await fs.symlink(target, path.join(dir, "node_modules", entry), "dir");
  }
  await fs.writeFile(
    path.join(dir, "node_modules/wrangler/package.json"),
    JSON.stringify({
      name: "wrangler",
      version: "0.0.0",
      type: "module",
      bin: { wrangler: "bin/wrangler.js" },
    }),
  );
  await fs.writeFile(
    path.join(dir, "node_modules/wrangler/bin/wrangler.js"),
    [
      'import fs from "node:fs";',
      'fs.writeFileSync("wrangler-args.json", JSON.stringify(process.argv.slice(2)));',
      `console.log("Deployed cf-app-basic\\n  ${DEPLOYED_URL}");`,
      "",
    ].join("\n"),
  );

  // The vinext + cloudflare() config moves out of the root config, which now
  // belongs to another tool.
  await fs.writeFile(
    path.join(dir, "vite.config.ts"),
    'export default { test: { include: ["**/*.test.ts"] } };\n',
  );
  return dir;
}

async function runDeploy(args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, "deploy", ...args],
      {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, output: (failed.stdout ?? "") + (failed.stderr ?? "") };
  }
}

async function startWorker(): Promise<void> {
  const wrangler = await fs.realpath(path.join(FIXTURE_DIR, "node_modules/wrangler"));
  worker = spawn(
    process.execPath,
    [
      path.join(wrangler, "bin/wrangler.js"),
      "dev",
      "--config",
      "dist/server/wrangler.json",
      "--ip",
      "127.0.0.1",
      "--port",
      String(PORT),
    ],
    { cwd: root, stdio: "inherit", detached: process.platform !== "win32" },
  );
  for (let attempt = 0; attempt < 240; attempt++) {
    if (worker.exitCode !== null) {
      throw new Error(`wrangler dev exited with code ${worker.exitCode}`);
    }
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the deployed cf-app-basic Worker");
}

function stopWorker(): void {
  if (!worker?.pid) return;
  if (process.platform === "win32") {
    worker.kill();
    return;
  }
  try {
    process.kill(-worker.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

test.describe("vinext-cloudflare deploy --vite-config", () => {
  test.beforeAll(async () => {
    root = await createProject();
  });

  test.afterAll(async () => {
    stopWorker();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  test("the root config alone cannot deploy the app", async () => {
    const result = await runDeploy([]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Missing @cloudflare/vite-plugin in your Vite config.");
  });

  test("rejects a --vite-config file that does not exist", async () => {
    const result = await runDeploy(["--vite-config", "vite.missing.config.ts"]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(
      `Vite config file not found: ${path.join(root, "vite.missing.config.ts")}`,
    );
  });

  test("builds and deploys with the selected Vite config", async ({ page, request }) => {
    test.setTimeout(300_000);

    const result = await runDeploy(["--vite-config", "vite.cdn-cache.config.ts"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Deployed to: ${DEPLOYED_URL}`);
    expect(JSON.parse(await fs.readFile(path.join(root, "wrangler-args.json"), "utf8"))).toEqual([
      "deploy",
    ]);

    await startWorker();

    // Only vite.cdn-cache.config.ts configures the Workers Cache CDN adapter,
    // which stamps the build identity on page responses.
    const response = await request.get(`${BASE_URL}/`);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-vinext-build-id"]).toBeTruthy();

    await page.goto(`${BASE_URL}/`);
    await expect(page.locator("h1")).toHaveText("Home");
  });
});
