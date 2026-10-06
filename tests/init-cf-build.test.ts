import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { init } from "../packages/vinext/src/init.js";

const webRoot = path.resolve(import.meta.dirname, "../apps/web");
const tempRoot = fs.mkdtempSync(path.join(webRoot, ".init-cf-build-"));

afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function typecheckProject(root: string): void {
  // Workspace-linked vinext resolves its dev Vite+ copy. Published consumers
  // share the app's Vite peer; model that single type identity in this fixture.
  const tsconfigPath = path.join(root, "tsconfig.json");
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
  tsconfig.compilerOptions.paths ??= {};
  tsconfig.compilerOptions.paths.vite = [
    path.join(webRoot, "node_modules/vite/dist/node/index.d.ts"),
  ];
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
  const tsc = fileURLToPath(new URL("bin/tsc", import.meta.resolve("typescript/package.json")));
  const types = spawnSync(process.execPath, [tsc, "--project", "tsconfig.json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(types.status, `${types.stdout}\n${types.stderr}`).toBe(0);
}

describe("default cf init build", () => {
  it("builds and type-checks a default create-vinext-app Cloudflare project", () => {
    const root = path.join(tempRoot, "created-cf-app");
    const create = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, "../packages/create-vinext-app/dist/cli.js"),
        root,
        "--platform=cloudflare",
        "--cdn-cache=response-store",
        "--skip-install",
        "--disable-git",
        "--yes",
      ],
      { encoding: "utf8", timeout: 30_000, env: { ...process.env, CI: "true" } },
    );
    expect(create.status, `${create.stdout}\n${create.stderr}`).toBe(0);
    const accountId = "0123456789abcdef0123456789abcdef";
    const observability = {
      enabled: true,
      headSamplingRate: 0.5,
      redactQueryString: true,
      issues: { enabled: false },
      logs: { enabled: true, headSamplingRate: 0.25, invocationLogs: false, persist: false },
      traces: { enabled: true, headSamplingRate: 0.1, persist: false },
    };
    const configPath = path.join(root, "cloudflare.config.ts");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace(
          "createWorkersResponseStoreServiceBindingConfig({",
          `createWorkersResponseStoreServiceBindingConfig({ accountId: ${JSON.stringify(accountId)},`,
        )
        .replace("worker: {", `worker: { observability: ${JSON.stringify(observability)},`)
        .replace("defineConfig({", "defineConfig({ accountId: responseStore.accountId,"),
    );
    const build = spawnSync(path.join(webRoot, "node_modules/.bin/vinext"), ["build"], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, CI: "true" },
    });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(root, ".cloudflare/types/index.d.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "wrangler.jsonc"))).toBe(false);
    const outputDir = path.join(root, ".cloudflare/output/v0");
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, "config.json"), "utf8"))).toMatchObject({
      accountId,
    });
    const responseStoreConfig = JSON.parse(
      fs.readFileSync(
        path.join(outputDir, "workers/created-cf-app-response-store/worker.config.json"),
        "utf8",
      ),
    );
    expect(responseStoreConfig.observability).toEqual(observability);
    expect(responseStoreConfig).not.toHaveProperty("accountId");
    typecheckProject(root);
  }, 150_000);

  it.each([
    ["service-binding", "app", "response-store", "service-binding"],
    ["pages-service-binding", "pages", "response-store", "service-binding"],
    ["self-contained", "app", "response-store", "self-contained"],
    ["workers-cache", "app", "workers-cache", undefined],
    ["workers-cache-kv", "app", "workers-cache", undefined],
    ["static-assets", "app", "static-assets", undefined],
    ["pages-static-assets", "pages", "static-assets", undefined],
    ["pages-static-assets-custom-assets", "pages", "static-assets", undefined],
    ["kv", "app", "data-cache", undefined],
    ["pages", "pages", "none", undefined],
  ] as const)(
    "builds generated %s config",
    async (name, router, cdnCache, responseStoreMode) => {
      const root = path.join(tempRoot, name);
      const legacyWrangler = name === "pages-static-assets-custom-assets";
      fs.mkdirSync(path.join(root, router), { recursive: true });
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: `init-cf-${name}`,
          version: "1.0.0",
          dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        }),
      );
      if (legacyWrangler) {
        // Legacy init installs plugin v1; apps/web supplies v2 for typed cf configs.
        fs.mkdirSync(path.join(root, "node_modules/@cloudflare"), { recursive: true });
        fs.symlinkSync(
          path.resolve(
            import.meta.dirname,
            "fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin",
          ),
          path.join(root, "node_modules/@cloudflare/vite-plugin"),
          "junction",
        );
        fs.writeFileSync(
          path.join(root, "wrangler.jsonc"),
          JSON.stringify({
            name: `init-cf-${name}`,
            main: "vinext/server/fetch-handler",
            compatibility_date: "2026-01-01",
            compatibility_flags: ["nodejs_compat"],
            assets: { directory: "build/client", binding: "STATIC", not_found_handling: "none" },
          }),
        );
      }
      if (legacyWrangler) {
        fs.mkdirSync(path.join(root, "public"));
        fs.writeFileSync(path.join(root, "public", "rewrite-target.txt"), "custom assets rewrite");
        fs.writeFileSync(
          path.join(root, "next.config.ts"),
          'export default { async rewrites() { return [{ source: "/public-alias", destination: "/rewrite-target.txt" }]; } };',
        );
      }
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
      const hasCssModules = name === "service-binding" || name === "pages";
      if (hasCssModules) {
        // init installs this dependency for CSS Modules; reuse the workspace fixture's copy.
        fs.mkdirSync(path.join(root, "node_modules"));
        fs.symlinkSync(
          path.resolve(
            import.meta.dirname,
            "fixtures/init-css-modules/node_modules/vite-css-modules",
          ),
          path.join(root, "node_modules/vite-css-modules"),
          "junction",
        );
        fs.writeFileSync(path.join(root, router, "card.module.css"), ".card { color: red }");
        fs.writeFileSync(
          path.join(root, router, router === "app" ? "page.tsx" : "index.tsx"),
          'import styles from "./card.module.css";\nexport default function Home() { return <main className={styles.card}>cf init smoke test</main> }',
        );
      }
      // create-next-app uses bundler resolution without allowImportingTsExtensions:
      // https://github.com/vercel/next.js/blob/canary/packages/create-next-app/templates/app/ts/tsconfig.json
      const tsconfig = JSON.stringify({
        compilerOptions: {
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          module: "esnext",
          moduleResolution: "bundler",
          noEmit: true,
          strict: true,
          skipLibCheck: true,
        },
        include: ["vite.config.ts", "cloudflare.config.ts", ".cloudflare/types"],
      });
      if (responseStoreMode === "service-binding") {
        fs.writeFileSync(path.join(root, "tsconfig.json"), tsconfig);
      }
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await init({
          root,
          platform: "cloudflare",
          skipCheck: true,
          install: false,
          _today: "2026-09-23",
          cloudflare: {
            dataCache: name === "workers-cache-kv" || name === "kv" ? "kv" : "none",
            cdnCache,
            responseStoreMode,
            legacyWrangler,
            imageOptimization: router === "pages" ? "cloudflare-images" : "none",
          },
        });
      } finally {
        log.mockRestore();
      }
      if (responseStoreMode === "service-binding") {
        expect(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")).toBe(tsconfig);
      }
      const vinext = path.join(webRoot, "node_modules", ".bin", "vinext");
      const build = spawnSync(vinext, ["build"], {
        cwd: root,
        encoding: "utf-8",
        timeout: 120_000,
        env: { ...process.env, CI: "true" },
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      expect(fs.existsSync(path.join(root, ".cloudflare/types/index.d.ts"))).toBe(!legacyWrangler);
      expect(fs.existsSync(path.join(root, "worker-configuration.d.ts"))).toBe(false);
      if (responseStoreMode === "service-binding") typecheckProject(root);
      const workersDir = path.join(root, ".cloudflare", "output", "v0", "workers");
      if (legacyWrangler) {
        const workerConfig = JSON.parse(
          fs.readFileSync(path.join(root, "dist/server/wrangler.json"), "utf8"),
        );
        expect(workerConfig.assets.binding).toBe("STATIC");
        expect(path.resolve(root, "dist/server", workerConfig.assets.directory)).toBe(
          path.join(root, "build/client"),
        );
      } else {
        expect(
          fs.existsSync(path.join(workersDir, "default", "worker.config.json")),
          `${build.stdout}\n${build.stderr}`,
        ).toBe(true);
        expect(fs.readdirSync(workersDir).includes(`init-cf-${name}-response-store`)).toBe(
          responseStoreMode === "service-binding",
        );
      }
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      expect(pkg.scripts["deploy:response-store"]).toBe(
        responseStoreMode === "service-binding"
          ? `cf deploy --prebuilt --mode production --worker init-cf-${name}-response-store`
          : undefined,
      );
      if (name === "service-binding" || name === "pages" || cdnCache === "static-assets") {
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
          const html = await response.text();
          expect(html).toContain("cf init smoke test");
          if (hasCssModules) expect(html).toMatch(/class="_card_[a-f0-9]{7}"/);
          if (legacyWrangler) {
            // Next.js resolves public files after config rewrites; the Worker
            // must use the same custom binding as its Static Assets cache.
            // https://github.com/vercel/next.js/blob/canary/test/e2e/custom-routes/custom-routes.test.ts
            const rewritten = await fetch(new URL("/public-alias", url));
            expect(rewritten.status).toBe(200);
            expect(await rewritten.text()).toBe("custom assets rewrite");
          }
          if (cdnCache === "static-assets") {
            expect(response.headers.get("x-vinext-cache")).toBe("HIT");
            if (router === "app") {
              const rsc = await fetch(url, { headers: { Accept: "text/x-component", RSC: "1" } });
              expect(rsc.status).toBe(200);
              expect(rsc.headers.get("x-vinext-cache")).toBe("HIT");
              expect(await rsc.text()).toContain("cf init smoke test");
            }
            const cachePath = "/_vinext/static-cache";
            const assetsDir = legacyWrangler
              ? path.join(root, "build/client")
              : path.join(workersDir, "default/assets");
            const artifacts = fs.readdirSync(path.join(assetsDir, cachePath));
            expect(artifacts).toContain("index.json");
            if (router === "app") {
              expect(artifacts.some((file) => file.endsWith(".html"))).toBe(true);
              expect(artifacts.some((file) => file.endsWith(".rsc"))).toBe(true);
            } else {
              expect(artifacts.some((file) => file.endsWith(".pages"))).toBe(true);
            }
            for (const file of artifacts) {
              const privateAsset = await fetch(new URL(`${cachePath}/${file}`, url));
              expect(privateAsset.status, file).toBe(404);
            }
          }
        } finally {
          preview.kill();
        }
      }
    },
    130_000,
  );
});
