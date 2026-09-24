/**
 * `vinext build --prerender-all` on a Cloudflare target imports the built
 * Worker bundle (`dist/server/index.js`) into the Node prerender harness.
 * Workerd resolves `cloudflare:*`, Node does not: the bundle keeps
 * `import { env } from "cloudflare:workers"` external, so `node:module`'s ESM
 * loader threw ERR_UNSUPPORTED_ESM_URL_SCHEME before a single route rendered.
 * Refs cloudflare/vinext#3319.
 *
 * The loader hooks that stub `cloudflare:*` live in the CLI process, which is
 * why this must run the real CLI as a subprocess: Vite's in-process module
 * runner never touches Node's ESM loader.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vite-plus/test";
import { createIsolatedFixture } from "./helpers.js";

const execFileAsync = promisify(execFile);

const CF_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/cf-prerender-bindings");
const CF_NODE_MODULES = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic/node_modules");
const VINEXT_CLI = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");

const UNRESOLVED_WORKER_SPECIFIER =
  /ERR_UNSUPPORTED_ESM_URL_SCHEME|Cannot find package 'cloudflare\//;

let tmpDir = "";

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

it("prerenders a Cloudflare app whose server bundle imports cloudflare:workers", async () => {
  tmpDir = await createIsolatedFixture(
    CF_FIXTURE,
    "vinext-cf-bindings-",
    undefined,
    CF_NODE_MODULES,
  );

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [VINEXT_CLI, "build", "--prerender-all"],
    { cwd: tmpDir, env: { ...process.env, NODE_ENV: "production" } },
  );

  expect(stdout).not.toMatch(UNRESOLVED_WORKER_SPECIFIER);
  expect(stderr).not.toMatch(UNRESOLVED_WORKER_SPECIFIER);

  const prerenderedDir = path.join(tmpDir, "dist", "server", "prerendered-routes");
  expect(fs.readFileSync(path.join(prerenderedDir, "index.html"), "utf8")).toContain(
    'data-env="object">',
  );
  expect(fs.existsSync(path.join(prerenderedDir, "bindings.html"))).toBe(true);
  expect(fs.existsSync(path.join(prerenderedDir, "bindings.rsc"))).toBe(true);

  expect(fs.readFileSync(path.join(tmpDir, "dist", "server", "index.js"), "utf8")).toContain(
    "cloudflare:workers",
  );
}, 180_000);
