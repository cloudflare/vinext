import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const vinextCli = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const viteCli = path.join(path.dirname(fileURLToPath(import.meta.resolve("vite"))), "cli.js");
const cloudflareNodeModules = path.resolve(
  import.meta.dirname,
  "fixtures/cf-app-basic/node_modules",
);

// Next.js also prints the route and original cause during build-time rendering:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/export/worker.ts
// Unlike a static export, vinext's speculative prerender may skip failed routes;
// that must not hide the reason from the build terminal.
it.each([vinextCli, viteCli])(
  "prints Cloudflare binding errors during CLI prerender (%s)",
  async (cli) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-prerender-error-output-"));
    const files = {
      "package.json": JSON.stringify({ name: "prerender-error-output", type: "module" }),
      "wrangler.jsonc": JSON.stringify({
        name: "prerender-error-output",
        main: "vinext/server/fetch-handler",
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat"],
        assets: { binding: "ASSETS" },
      }),
      "vite.config.ts": `
        import vinext from "vinext";
        import { cloudflare } from "@cloudflare/vite-plugin";
        export default {
          plugins: [
            vinext({ prerender: { routes: "*", concurrency: 1 } }),
            cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
          ],
        };
      `,
      "app/layout.tsx": `export default function Layout({ children }) {
        return <html><body>{children}</body></html>;
      }`,
      "app/page.tsx": `export default function Page() { return <h1>static page</h1>; }`,
      "app/binding/page.tsx": `
        import { env } from "cloudflare:workers";
        export default function Page() { return <h1>{env.MY_BINDING}</h1>; }
      `,
      "app/dynamic/page.tsx": `
        import { headers } from "next/headers";
        export default async function Page() { return <h1>{(await headers()).get("host")}</h1>; }
      `,
    };
    try {
      await fs.symlink(cloudflareNodeModules, path.join(root, "node_modules"), "junction");
      for (const [name, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await fs.writeFile(path.join(root, name), content);
      }
      const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "build"], {
        cwd: root,
        env: { ...process.env, NODE_ENV: "production", NO_COLOR: "1" },
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      expect(stdout).toContain("Build complete.");
      expect(stderr).toContain('Error prerendering route "/binding"');
      expect(stderr).toContain(
        "Cloudflare bindings are unavailable during build-time prerendering",
      );
      expect(stderr).toContain("Use cache warming for binding-dependent routes.");
      expect(stderr).not.toContain('Error prerendering route "/dynamic"');
      expect(stderr).not.toContain("prerender render pool failed to start");

      const manifest = JSON.parse(
        await fs.readFile(path.join(root, "dist/server/vinext-prerender.json"), "utf8"),
      );
      expect(manifest.routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ route: "/", status: "rendered" }),
          expect.objectContaining({ route: "/binding", status: "skipped" }),
          expect.objectContaining({ route: "/dynamic", status: "skipped" }),
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  150_000,
);
