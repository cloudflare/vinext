import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";
import { createIsolatedFixture } from "./helpers.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-ppr-fallback-shell");
const NODE_MODULES_DIR = path.resolve(import.meta.dirname, "fixtures/app-basic/node_modules");

// Ported from Next.js: test/e2e/app-dir/use-cache-caught-error/use-cache-caught-error.test.ts
// https://github.com/vercel/next.js/blob/a0e2b5dc4c1a0075508e3d4b8bd4b86455397f0a/test/e2e/app-dir/use-cache-caught-error/use-cache-caught-error.test.ts
it("caches a rendered fallback when a use cache function throws", async () => {
  const root = await createIsolatedFixture(
    FIXTURE_DIR,
    "vinext-use-cache-caught-error-",
    undefined,
    NODE_MODULES_DIR,
  );
  let server: Awaited<ReturnType<typeof startProdServer>>["server"] | undefined;
  try {
    await execFileAsync(process.execPath, [CLI_PATH, "build"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NO_COLOR: "1",
        __VINEXT_EXPERIMENTAL_PPR_FALLBACK_SHELLS: "1",
      },
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    ({ server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    for (const id of ["static", "runtime"]) {
      const url = `${baseUrl}/en/caught/${id}`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-nextjs-cache")).toBe(id === "static" ? "HIT" : "MISS");
      const html = await response.text();
      expect(html).toContain('<p id="caught-cache-fallback">');
      expect(html.replaceAll("<!-- -->", "")).toContain(`fallback for ${id}</p>`);

      await expect
        .poll(async () => {
          const cached = await fetch(url);
          await cached.arrayBuffer();
          return cached.headers.get("x-nextjs-cache");
        })
        .toBe("HIT");
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
