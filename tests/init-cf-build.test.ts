import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { init } from "../packages/vinext/src/init.js";

const webRoot = path.resolve(import.meta.dirname, "../apps/web");
const tempRoot = fs.mkdtempSync(path.join(webRoot, ".init-cf-build-"));

afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

describe("experimental cf init build", () => {
  it.each([
    ["service-binding", "app", "response-store", "service-binding"],
    ["pages-service-binding", "pages", "response-store", "service-binding"],
    ["self-contained", "app", "response-store", "self-contained"],
    ["workers-cache", "app", "workers-cache", undefined],
    ["pages", "pages", "none", undefined],
  ] as const)(
    "builds generated %s config",
    async (name, router, cdnCache, responseStoreMode) => {
      const root = path.join(tempRoot, name);
      fs.mkdirSync(path.join(root, router), { recursive: true });
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: `init-cf-${name}`,
          version: "1.0.0",
          dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        }),
      );
      if (router === "app") {
        fs.writeFileSync(
          path.join(root, "app", "layout.tsx"),
          "export default function Layout({ children }) { return <html><body>{children}</body></html> }",
        );
        fs.writeFileSync(
          path.join(root, "app", "page.tsx"),
          "export default function Home() { return <main>cf init smoke test</main> }",
        );
      } else {
        fs.writeFileSync(
          path.join(root, "pages", "index.tsx"),
          "export default function Home() { return <main>cf init smoke test</main> }",
        );
      }
      fs.symlinkSync(
        path.join(webRoot, "node_modules"),
        path.join(root, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await init({
          root,
          platform: "cloudflare",
          skipCheck: true,
          install: false,
          _today: "2026-09-23",
          cloudflare: {
            dataCache: "none",
            cdnCache,
            responseStoreMode,
            imageOptimization: router === "pages" ? "cloudflare-images" : "none",
            experimentalCf: true,
          },
        });
      } finally {
        log.mockRestore();
      }
      const cf = path.join(webRoot, "node_modules", ".bin", "cf");
      const build = spawnSync(cf, ["build"], {
        cwd: root,
        encoding: "utf-8",
        timeout: 120_000,
        env: { ...process.env, CI: "true" },
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      const workersDir = path.join(root, ".cloudflare", "output", "v0", "workers");
      expect(
        fs.existsSync(path.join(workersDir, "default", "worker.config.json")),
        `${build.stdout}\n${build.stderr}`,
      ).toBe(true);
      expect(fs.readdirSync(workersDir).includes(`init-cf-${name}-response-store`)).toBe(
        responseStoreMode === "service-binding",
      );
      if (name === "service-binding") {
        const preview = spawn(
          path.join(webRoot, "node_modules", ".bin", "vite"),
          ["preview", "--host", "127.0.0.1", "--port", "0"],
          {
            cwd: root,
            env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        try {
          const url = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`Vite preview did not start: ${output}`)),
              30_000,
            );
            const onOutput = (chunk: Buffer) => {
              output += chunk.toString();
              const match = stripVTControlCharacters(output).match(/http:\/\/127\.0\.0\.1:\d+\//);
              if (match) {
                clearTimeout(timer);
                resolve(match[0]);
              }
            };
            preview.stdout.on("data", onOutput);
            preview.stderr.on("data", onOutput);
            preview.once("exit", (code) => {
              clearTimeout(timer);
              reject(new Error(`Vite preview exited with ${code}: ${output}`));
            });
          });
          const response = await fetch(url);
          expect(response.status, output).toBe(200);
          expect(await response.text()).toContain("cf init smoke test");
        } finally {
          preview.kill();
        }
      }
    },
    130_000,
  );
});
