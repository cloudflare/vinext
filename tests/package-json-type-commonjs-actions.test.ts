/**
 * Reproduction for https://github.com/cloudflare/vinext/issues/4565
 *
 * Ported from Next.js: test/e2e/app-dir/package-json-type-commonjs/package-json-type-commonjs.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/package-json-type-commonjs/package-json-type-commonjs.test.ts
 *
 * Next.js compiles a generated Server Actions entry as `.mjs` so a root
 * `"type": "commonjs"` package.json cannot reclassify the ESM source as CJS.
 * This file submits an inline form action in that scope (dev + production),
 * including a nested `"type": "module"` override and an ordinary ESM control.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { createBuilder } from "vite";
import type { ViteDevServer } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";
import { fetchHtml, startFixtureServer, testCacheDir } from "./helpers.js";

const WORKSPACE_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

const MJS_LAYOUT = `/**
 * @param {Object} props
 * @param {import("react").ReactNode} props.children
 */
export default function Root({ children }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
`;

const MJS_PAGE = `import { redirect } from "next/navigation";

export default function Page() {
  return (
    <main>
      <form
        action={async () => {
          "use server";
          redirect("/result");
        }}
      >
        <button type="submit">Go</button>
      </form>
    </main>
  );
}
`;

const MJS_RESULT = `export default function Result() {
  return <p data-testid="action-result">action-ok</p>;
}
`;

const TSX_LAYOUT = `export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
`;

const TSX_PAGE = `import { redirect } from "next/navigation";

export default function Page() {
  return (
    <main>
      <form
        action={async () => {
          "use server";
          redirect("/result");
        }}
      >
        <button type="submit">Go</button>
      </form>
    </main>
  );
}
`;

const TSX_RESULT = `export default function Result() {
  return <p data-testid="action-result">action-ok</p>;
}
`;

type FixtureKind = "root-commonjs-mjs" | "nested-module" | "esm-control";

async function writeFixtureFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function createFixture(kind: FixtureKind): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `vinext-cjs-actions-${kind}-`));
  await symlink(WORKSPACE_NODE_MODULES, path.join(root, "node_modules"), "dir");

  switch (kind) {
    case "root-commonjs-mjs":
      await writeFixtureFile(
        root,
        "package.json",
        JSON.stringify({ private: true, type: "commonjs" }),
      );
      await writeFixtureFile(
        root,
        "next.config.mjs",
        `export default { pageExtensions: ["js", "jsx", "mjs"] };\n`,
      );
      await writeFixtureFile(root, "app/layout.mjs", MJS_LAYOUT);
      await writeFixtureFile(root, "app/page.mjs", MJS_PAGE);
      await writeFixtureFile(root, "app/result/page.mjs", MJS_RESULT);
      break;
    case "nested-module":
      await writeFixtureFile(
        root,
        "package.json",
        JSON.stringify({ private: true, type: "commonjs" }),
      );
      await writeFixtureFile(root, "app/package.json", JSON.stringify({ type: "module" }));
      await writeFixtureFile(root, "app/layout.tsx", TSX_LAYOUT);
      await writeFixtureFile(root, "app/page.tsx", TSX_PAGE);
      await writeFixtureFile(root, "app/result/page.tsx", TSX_RESULT);
      break;
    case "esm-control":
      await writeFixtureFile(
        root,
        "package.json",
        JSON.stringify({ private: true, type: "module" }),
      );
      await writeFixtureFile(root, "app/layout.tsx", TSX_LAYOUT);
      await writeFixtureFile(root, "app/page.tsx", TSX_PAGE);
      await writeFixtureFile(root, "app/result/page.tsx", TSX_RESULT);
      break;
    default: {
      const _exhaustive: never = kind;
      throw new Error("unhandled fixture: " + String(_exhaustive));
    }
  }

  return root;
}

function extractActionId(html: string): string {
  const match = html.match(/name="\$ACTION_ID_([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`Missing $ACTION_ID_ in HTML:\n${html.slice(0, 1500)}`);
  }
  return match[1];
}

async function submitInlineAction(baseUrl: string, actionId: string): Promise<Response> {
  const form = new FormData();
  form.append(`$ACTION_ID_${actionId}`, "");
  return fetch(`${baseUrl}/`, {
    method: "POST",
    headers: { Origin: baseUrl, Host: new URL(baseUrl).host },
    body: form,
    redirect: "manual",
  });
}

async function expectActionResult(baseUrl: string, html: string): Promise<void> {
  const actionId = extractActionId(html);
  const res = await submitInlineAction(baseUrl, actionId);
  if (res.status === 303 || res.status === 307 || res.status === 308) {
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const dest = new URL(location!, baseUrl);
    expect(dest.pathname).toBe("/result");
    const { res: resultRes, html: resultHtml } = await fetchHtml(
      baseUrl,
      dest.pathname + dest.search,
    );
    expect(resultRes.status).toBe(200);
    expect(resultHtml).toContain("action-ok");
    return;
  }

  const body = await res.text();
  expect(res.status, body.slice(0, 1500)).toBe(200);
  expect(body).toContain("action-ok");
}

function expectNativeNodeCanImport(file: string): void {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`native import ${file} failed:\n${result.stderr || result.stdout}`);
  }
}

async function buildFixtureInPlace(root: string): Promise<string> {
  const builder = await createBuilder({
    root,
    cacheDir: testCacheDir(root),
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();
  return path.join(root, "dist");
}

describe("Server Actions under package.json module type (issue 4565)", () => {
  const fixtures: { kind: FixtureKind; label: string }[] = [
    { kind: "root-commonjs-mjs", label: "root type:commonjs with .mjs page/layout" },
    { kind: "nested-module", label: "root type:commonjs overridden by app type:module" },
    { kind: "esm-control", label: "ordinary ESM control" },
  ];

  for (const { kind, label } of fixtures) {
    describe(label, () => {
      const roots: string[] = [];
      let devServer: ViteDevServer | undefined;
      let prodServer: Server | undefined;

      afterAll(async () => {
        await devServer?.close();
        await new Promise<void>((resolve, reject) => {
          if (!prodServer) return resolve();
          prodServer.close((error) => (error ? reject(error) : resolve()));
        });
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
      });

      it("renders and submits the inline Server Action in development", async () => {
        const root = await createFixture(kind);
        roots.push(root);
        const started = await startFixtureServer(root, { appRouter: true });
        devServer = started.server;
        const { res, html } = await fetchHtml(started.baseUrl, "/");
        expect(res.status, html.slice(0, 1500)).toBe(200);
        expect(html).toContain("<form");
        await expectActionResult(started.baseUrl, html);
      }, 60_000);

      it("builds, starts, and submits the inline Server Action in production", async () => {
        const root = await createFixture(kind);
        roots.push(root);
        const outDir = await buildFixtureInPlace(root);
        const serverDir = path.join(outDir, "server");
        if (kind !== "esm-control") {
          const manifestMjs = path.join(serverDir, "__vinext_action_owner_manifest.mjs");
          expect(
            existsSync(manifestMjs),
            "generated action-owner artifact must be explicit ESM",
          ).toBe(true);
          expectNativeNodeCanImport(manifestMjs);
        }
        const ssrJs = path.join(serverDir, "ssr", "index.js");
        const ssrMjs = path.join(serverDir, "ssr", "index.mjs");
        if (existsSync(ssrJs)) expectNativeNodeCanImport(ssrJs);
        else expectNativeNodeCanImport(ssrMjs);
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
          throw new Error(`process.exit(${String(code)})`);
        });
        let server: Server;
        try {
          ({ server } = await startProdServer({
            port: 0,
            host: "127.0.0.1",
            outDir,
            noCompression: true,
            silent: true,
          }));
        } finally {
          exitSpy.mockRestore();
        }
        prodServer = server;
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Production server did not bind");
        }
        const prodBaseUrl = `http://127.0.0.1:${address.port}`;
        const { res, html } = await fetchHtml(prodBaseUrl, "/");
        expect(res.status, html.slice(0, 1500)).toBe(200);
        expect(html).toContain("<form");
        await expectActionResult(prodBaseUrl, html);
      }, 120_000);
    });
  }
});
