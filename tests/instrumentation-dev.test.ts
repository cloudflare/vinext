import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import { startFixtureServer } from "./helpers.js";

async function withInstrumentationFixture(
  options: { importKind?: "static" | "dynamic"; hybrid?: boolean },
  run: (fixture: { root: string; start: () => Promise<string> }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-instrumentation-dev-"));
  const stateKey = `instrumentation:${root}`;
  let server: ViteDevServer | undefined;
  const write = async (name: string, code: string) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, code);
  };

  try {
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await write("package.json", JSON.stringify({ type: "module", private: true }));
    await write(
      "app/layout.tsx",
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    );
    await write(
      "app/page.tsx",
      "export default function Page() { return <main>instrumentation</main>; }",
    );
    await write(
      "state.js",
      `export const state = globalThis[${JSON.stringify(stateKey)}] ??= { registrations: 0, events: [] };`,
    );
    await write(
      "service.js",
      `${options.hybrid ? "" : 'import "server-only";'}
let initialized = false;
export async function initialize() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  initialized = true;
}
export function isInitialized() { return initialized; }
`,
    );
    await write(
      "instrumentation.js",
      `import * as React from "react";
import { state } from "./state.js";
${options.importKind === "static" ? 'import "server-only";\nimport { initialize } from "./service.js";' : ""}
export async function register() {
  if ("useState" in React) throw new Error("instrumentation requires react-server conditions");
  state.registrations++;
  state.events.push("register:start");
  ${options.importKind === "static" ? "" : 'const { initialize } = await import("./service.js");'}
  await initialize();
  state.events.push("register:end");
}
`,
    );
    await write(
      "app/probe/route.js",
      `import { isInitialized } from "../../service.js";
import { state } from "../../state.js";
const initializedAtImport = isInitialized();
state.events.push("app:import");
export function GET() {
  return Response.json({ ...state, initializedAtImport, initialized: isInitialized() });
}
`,
    );
    if (options.hybrid) {
      await write(
        "pages/api/probe.js",
        `import { isInitialized } from "../../service.js";
import { state } from "../../state.js";
const initializedAtImport = isInitialized();
const registeredAtImport = state.events.includes("register:end");
state.events.push("pages:import");
export default function handler(_request, response) {
  response.json({ ...state, initializedAtImport, initialized: isInitialized(), registeredAtImport });
}
`,
      );
    }

    await run({
      root,
      async start() {
        const started = await startFixtureServer(root);
        server = started.server;
        return started.baseUrl;
      },
    });
  } finally {
    await server?.close();
    Reflect.deleteProperty(globalThis, stateKey);
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("Node dev instrumentation", () => {
  // Next.js requires react-server conditions and registration before user modules:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/rsc-layers-transform/instrumentation.js
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/instrumentation-order/instrumentation-order.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/instrumentation-hook/register-once/register-once.test.ts
  it.each([
    { importKind: "static" as const, hybrid: false },
    { importKind: "dynamic" as const, hybrid: false },
    { importKind: "dynamic" as const, hybrid: true },
  ])("initializes $importKind instrumentation once (hybrid: $hybrid)", async (options) => {
    await withInstrumentationFixture(options, async ({ root, start }) => {
      const checkClientBoundary = options.importKind === "dynamic" && !options.hybrid;
      if (checkClientBoundary) {
        await fs.mkdir(path.join(root, "app/invalid"));
        await fs.writeFile(
          path.join(root, "app/invalid/page.tsx"),
          `"use client";
import { isInitialized } from "../../service.js";
export default function Page() { return <main>{String(isInitialized())}</main>; }
`,
        );
      }
      const baseUrl = await start();
      if (options.hybrid) {
        const pagesResponse = await fetch(`${baseUrl}/api/probe`);
        expect(pagesResponse.status).toBe(200);
        await expect(pagesResponse.json()).resolves.toEqual({
          // Like Next.js, instrumentation runs in a separate server-layer
          // module graph. Process-global effects cross into Pages; local
          // module state does not.
          initialized: false,
          initializedAtImport: false,
          registrations: 1,
          registeredAtImport: true,
          events: ["register:start", "register:end", "pages:import"],
        });
      }

      const responses = await Promise.all(
        Array.from({ length: 3 }, () => fetch(`${baseUrl}/probe`)),
      );
      responses.push(await fetch(`${baseUrl}/probe`));
      for (const response of responses) {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          initialized: true,
          initializedAtImport: true,
          registrations: 1,
          events: [
            "register:start",
            "register:end",
            ...(options.hybrid ? ["pages:import"] : []),
            "app:import",
          ],
        });
      }

      if (checkClientBoundary) {
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const response = await fetch(`${baseUrl}/invalid`);
          expect(response.status).toBe(500);
          await response.text();
          expect(errorLog).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
              message: expect.stringContaining(
                "'server-only' cannot be imported in client build ('ssr' environment)",
              ),
            }),
          );
        } finally {
          errorLog.mockRestore();
        }
      }
    });
  });

  it("propagates registration failures to App requests", async () => {
    await withInstrumentationFixture({}, async ({ root, start }) => {
      await fs.writeFile(
        path.join(root, "instrumentation.js"),
        `export async function register() {
  throw new Error("instrumentation registration failed");
}`,
      );
      const baseUrl = await start();
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${baseUrl}/probe`);
        expect(response.status).toBe(500);
        expect(await response.text()).toContain("instrumentation registration failed");
      }
    });
  });
});
