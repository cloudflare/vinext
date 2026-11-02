/**
 * `vinext init --platform=cloudflare --ignore-wrangler-config` next to a root
 * Wrangler config for an unrelated Worker. Init sets up `cloudflare.config.ts`,
 * leaves the Wrangler file untouched, and the built app neither reads it nor
 * picks up its bindings.
 *
 * See https://github.com/cloudflare/vinext/issues/4199.
 */
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { waitForAppRouterHydration } from "../helpers";

const example = path.resolve(process.cwd(), "examples/static-assets-cache");
// The example's own Cloudflare setup, which init regenerates.
const generatedFiles = new Set(["vite.config.ts", "cloudflare.config.ts"]);
const skippedDirs = new Set(["node_modules", "dist", ".cloudflare", ".wrangler"]);
const otherWorkerConfig = `name = "other-worker"
main = "src/other.ts"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "OTHER_KV"
id = "other-worker-kv"
`;

function runVite(root: string, args: string[]): ChildProcess {
  return spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function viteBuild(root: string): Promise<void> {
  const child = runVite(root, ["build"]);
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`vite build exited with ${code}:\n${output}`);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("No free port");
  return address.port;
}

async function vitePreview(root: string, port: number): Promise<ChildProcess> {
  const child = runVite(root, ["preview", "--host", "127.0.0.1", "--port", String(port)]);
  let output = "";
  let exitCode: number | null | undefined;
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  child.on("exit", (code) => (exitCode = code));
  // Poll the port: CI colors the printed URL, so its text is not a reliable signal.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exitCode !== undefined) throw new Error(`vite preview exited with ${exitCode}:\n${output}`);
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return child;
    } catch {}
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`vite preview did not start:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test("init sets up cf alongside an unrelated Wrangler config", async ({ page }) => {
  test.skip(Boolean(process.env.VINEXT_E2E_BASE_URL), "runs init and a local build");
  test.setTimeout(180_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-init-ignore-wrangler-"));
  let preview: ChildProcess | undefined;
  try {
    await fs.cp(example, root, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(example, source);
        return !generatedFiles.has(relative) && !skippedDirs.has(relative.split(path.sep)[0]);
      },
    });
    await fs.symlink(path.join(example, "node_modules"), path.join(root, "node_modules"), "dir");
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "src/other.ts"),
      'export default { fetch: () => new Response("other worker") };\n',
    );
    await fs.writeFile(path.join(root, "wrangler.toml"), otherWorkerConfig);

    // What `vinext init` runs for these flags. The compatibility date is pinned
    // to one the installed workerd supports.
    const { resolveInitOptions } = await import("../../../packages/vinext/src/init-platform.js");
    const { init } = await import("../../../packages/vinext/src/init.js");
    const args = [
      "--platform=cloudflare",
      "--ignore-wrangler-config",
      "--cdn-cache=none",
      "--data-cache=none",
      "--image-optimization=none",
    ];
    await init({
      root,
      skipCheck: true,
      install: false,
      ...(await resolveInitOptions(args, { env: {}, isInteractive: false })),
      _today: "2026-04-08",
    });

    expect(await fs.readFile(path.join(root, "wrangler.toml"), "utf8")).toBe(otherWorkerConfig);
    expect(await fs.readFile(path.join(root, "cloudflare.config.ts"), "utf8")).toContain(
      'name: "static-assets-cache"',
    );

    await viteBuild(root);
    const workerConfig = JSON.parse(
      await fs.readFile(
        path.join(root, ".cloudflare/output/v0/workers/default/worker.config.json"),
        "utf8",
      ),
    ) as { name: string; env: Record<string, unknown> };
    expect(workerConfig.name).toBe("static-assets-cache");
    expect(workerConfig.env).toHaveProperty("ASSETS");
    expect(workerConfig.env).not.toHaveProperty("OTHER_KV");

    const port = await freePort();
    preview = await vitePreview(root, port);
    await page.goto(`http://127.0.0.1:${port}/`);
    await expect(page.locator("h1")).toHaveText("vinext Static Assets cache");
    await waitForAppRouterHydration(page);
    await page.locator('nav a[href="/about"]').click();
    await expect(page).toHaveURL(`http://127.0.0.1:${port}/about`);
    await expect(page.locator("h1")).toHaveText("Prebuilt about page");
  } finally {
    preview?.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});
