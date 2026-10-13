import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { toSlash } from "pathslash";
import { createServer, resolveConfig, type InlineConfig } from "vite";
import vinext from "../packages/vinext/src/index.js";

const roots: string[] = [];

function createAppProject(): string {
  // Vite keys the module graph by real path (macOS tmpdir is a symlink).
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pretransform-")),
  );
  roots.push(root);
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(
    path.join(root, "app/layout.tsx"),
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  fs.writeFileSync(
    path.join(root, "app/page.tsx"),
    'import { Greeting } from "./greeting";\nexport default function Page() { return <Greeting />; }\n',
  );
  fs.writeFileSync(
    path.join(root, "app/greeting.tsx"),
    'import { message } from "./message";\nexport function Greeting() { return <main>{message}</main>; }\n',
  );
  fs.writeFileSync(path.join(root, "app/message.ts"), 'export const message = "hello";\n');
  return root;
}

async function resolveServerPreTransformRequests(
  config: InlineConfig,
  command: "serve" | "build" = "serve",
): Promise<Record<"rsc" | "ssr", boolean | undefined>> {
  const root = createAppProject();
  const { plugins = [], ...rest } = config;
  const resolved = await resolveConfig(
    {
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: root }), ...plugins],
      ...rest,
    },
    command,
  );
  return {
    rsc: resolved.environments.rsc?.dev.preTransformRequests,
    ssr: resolved.environments.ssr?.dev.preTransformRequests,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dev.preTransformRequests for server environments", () => {
  it("enables pre-transforms for the rsc and ssr environments in dev", async () => {
    await expect(resolveServerPreTransformRequests({})).resolves.toEqual({ rsc: true, ssr: true });
  });

  it("respects an explicit environment setting", async () => {
    await expect(
      resolveServerPreTransformRequests({
        environments: { rsc: { dev: { preTransformRequests: false } } },
      }),
    ).resolves.toEqual({ rsc: false, ssr: true });
  });

  it("respects an explicit top-level dev.preTransformRequests", async () => {
    await expect(
      resolveServerPreTransformRequests({ dev: { preTransformRequests: false } }),
    ).resolves.toEqual({ rsc: false, ssr: false });
  });

  it("prefers top-level dev.preTransformRequests over server.preTransformRequests", async () => {
    await expect(
      resolveServerPreTransformRequests({
        dev: { preTransformRequests: false },
        server: { preTransformRequests: true },
      }),
    ).resolves.toEqual({ rsc: false, ssr: false });
  });

  it("respects an explicit top-level server.preTransformRequests", async () => {
    await expect(
      resolveServerPreTransformRequests({ server: { preTransformRequests: false } }),
    ).resolves.toEqual({ rsc: false, ssr: false });
  });

  it.each([
    ["dev", { dev: { preTransformRequests: false } }],
    ["server", { server: { preTransformRequests: false } }],
  ] as const)("respects %s.preTransformRequests from a later plugin", async (_, value) => {
    await expect(
      resolveServerPreTransformRequests({
        plugins: [{ name: "opt-out", config: () => value }],
      }),
    ).resolves.toEqual({ rsc: false, ssr: false });
  });

  it("leaves build config at Vite's default", async () => {
    await expect(resolveServerPreTransformRequests({}, "build")).resolves.toEqual({
      rsc: false,
      ssr: false,
    });
  });

  it("transforms static imports of an rsc module before the runner requests them", async () => {
    const root = createAppProject();
    const server = await createServer({
      root,
      cacheDir: path.join(root, ".vite"),
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({ appDir: root }),
        {
          // Skip dependency optimization so the test never writes to (or races
          // on) an optimizer cache; only local module transforms matter here.
          name: "disable-deps-optimizer",
          configEnvironment: {
            order: "post",
            handler(_name, config) {
              config.optimizeDeps = { noDiscovery: true, include: [] };
            },
          },
        },
      ],
      server: { middlewareMode: true, ws: false },
    });
    try {
      const rsc = server.environments.rsc;
      // Transform the page without evaluating it, as the module runner would
      // on its first request.
      await rsc.transformRequest(path.join(root, "app/page.tsx"));
      await rsc.waitForRequestsIdle();

      for (const file of ["app/greeting.tsx", "app/message.ts"]) {
        const [mod] = rsc.moduleGraph.getModulesByFile(toSlash(path.join(root, file))) ?? [];
        expect(mod?.transformResult, file).toBeTruthy();
      }
    } finally {
      await server.close();
    }
  }, 30_000);
});
