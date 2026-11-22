import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";
import { createIsolatedFixture } from "./helpers.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const fixture = path.resolve(import.meta.dirname, "fixtures/app-static-params-server-action");
const appNodeModules = path.resolve(import.meta.dirname, "fixtures/app-basic/node_modules");

// Adapted from Next.js: test/production/app-dir/use-cache-generate-static-params-server-action/
// https://github.com/vercel/next.js/tree/canary/test/production/app-dir/use-cache-generate-static-params-server-action
it("prerenders parameters produced by an action returned from use cache", async () => {
  const root = await createIsolatedFixture(
    fixture,
    "vinext-static-params-action-",
    undefined,
    appNodeModules,
  );
  try {
    await execFileAsync(process.execPath, [cli, "build"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production", NO_COLOR: "1" },
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const prerendered = path.join(root, "dist/server/prerendered-routes/static-params");
    for (const slug of ["known", "also-known"]) {
      const html = await fs.readFile(path.join(prerendered, `${slug}.html`), "utf8");
      expect(html).toContain(`<p id="generated-slug">${slug}</p>`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
