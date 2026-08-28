import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createServer, resolveConfig } from "vite";
import rsc from "@vitejs/plugin-rsc";
import vinext from "../packages/vinext/src/index.js";
import { RSC_ENTRIES } from "./helpers.js";

const APP_WITH_SRC_ROOT = path.resolve(import.meta.dirname, "fixtures/app-with-src");
const APP_BASIC_ROOT = path.resolve(import.meta.dirname, "fixtures/app-basic");
const RSDW_VENDOR_ALIAS = "@vitejs/plugin-rsc/vendor/react-server-dom";

describe("App Router React/RSC compatibility validation", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-react-rsc-compat-"));
    fs.mkdirSync(path.join(root, "app"), { recursive: true });
    fs.writeFileSync(path.join(root, "app", "page.tsx"), "export default function Page() {}\n");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "react-rsc-compat-test",
        private: true,
        dependencies: { react: "19.3.0-canary-test", "react-dom": "19.3.0-canary-test" },
      }),
    );
    const reactDir = path.join(root, "node_modules", "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "19.3.0-canary-test", main: "index.js" }),
    );
    fs.writeFileSync(path.join(reactDir, "index.js"), "");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const command of ["serve", "build"] as const) {
    it(`rejects incompatible prerelease React in direct Vite ${command}`, async () => {
      await expect(
        resolveConfig(
          { root, plugins: vinext({ react: false, rsc: false }) },
          command,
          command === "build" ? "production" : "development",
        ),
      ).rejects.toThrow("npm install --save-prod react-server-dom-webpack@19.3.0-canary-test");
    });
  }

  it("rejects incompatible prerelease React with a relative Vite root", async () => {
    await expect(
      resolveConfig(
        {
          root: path.relative(process.cwd(), root),
          plugins: vinext({ react: false, rsc: false }),
        },
        "serve",
        "development",
      ),
    ).rejects.toThrow("npm install --save-prod react-server-dom-webpack@19.3.0-canary-test");
  });

  it("requires projectRoot when a custom root resolves a distinct RSC plugin copy", async () => {
    const pluginRoot = path.join(root, "node_modules", "@vitejs", "plugin-rsc");
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "@vitejs/plugin-rsc",
        version: "0.0.0-distinct-test",
        type: "module",
        exports: { ".": "./dist/index.js" },
      }),
    );
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default () => [];\n");

    await expect(
      resolveConfig(
        { root, configFile: false, plugins: vinext({ react: false }) },
        "build",
        "production",
      ),
    ).rejects.toThrow(`Pass projectRoot: ${JSON.stringify(root)} to vinext()`);
  });

  it("aliases the active RSC plugin vendor to an override from a relative custom root", async () => {
    const config = await resolveConfig(
      {
        root: path.relative(process.cwd(), APP_WITH_SRC_ROOT),
        configFile: false,
        plugins: vinext({ appDir: path.join(APP_WITH_SRC_ROOT, "src"), react: false }),
      },
      "build",
      "production",
    );

    expect(config.plugins.some((plugin) => plugin.name === "rsc:minimal")).toBe(true);
    const runtimeAlias = config.resolve.alias.find((entry) => entry.find === RSDW_VENDOR_ALIAS);
    expect(runtimeAlias?.replacement).toContain("/node_modules/react-server-dom-webpack");
  });

  it("auto-registers RSC and pins the vendor for a custom root without an override", async () => {
    const config = await resolveConfig(
      {
        root: path.relative(process.cwd(), APP_BASIC_ROOT),
        configFile: false,
        plugins: vinext({ projectRoot: APP_BASIC_ROOT, react: false }),
      },
      "build",
      "production",
    );

    expect(config.plugins.some((plugin) => plugin.name === "rsc:minimal")).toBe(true);
    const runtimeAlias = config.resolve.alias.find((entry) => entry.find === RSDW_VENDOR_ALIAS);
    expect(runtimeAlias?.replacement).toContain("plugin-rsc");
    expect(runtimeAlias?.replacement).toContain("/vendor/react-server-dom");
  });

  it("pins a child without an override to the vendor when its parent declares RSDW", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(APP_WITH_SRC_ROOT);
    let server: Awaited<ReturnType<typeof createServer>> | null = null;
    try {
      const config = await resolveConfig(
        {
          root: APP_BASIC_ROOT,
          configFile: false,
          plugins: vinext({ projectRoot: APP_BASIC_ROOT, react: false }),
        },
        "build",
        "production",
      );

      expect(config.plugins.some((plugin) => plugin.name === "rsc:minimal")).toBe(true);
      const runtimeAlias = config.resolve.alias.find((entry) => entry.find === RSDW_VENDOR_ALIAS);
      expect(runtimeAlias?.replacement).toContain("plugin-rsc");
      expect(runtimeAlias?.replacement).toContain("/vendor/react-server-dom");
      expect(runtimeAlias?.replacement).not.toContain("/node_modules/react-server-dom-webpack");

      for (const environment of Object.values(config.environments)) {
        const includes = environment.optimizeDeps.include ?? [];
        expect(includes.some((id) => id.startsWith("react-server-dom-webpack/"))).toBe(false);
        expect(includes.some((id) => id.startsWith(`${RSDW_VENDOR_ALIAS}/`))).toBe(true);
      }

      server = await createServer({
        root: APP_BASIC_ROOT,
        cacheDir: path.join(root, "auto-runtime-cache"),
        configFile: false,
        plugins: vinext({ projectRoot: APP_BASIC_ROOT }),
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Expected a local dev address");
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Welcome to App Router");
    } finally {
      await server?.close();
      cwdSpy.mockRestore();
    }
  }, 30_000);

  it("pins a manually registered RSC plugin to the child vendor runtime", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(APP_WITH_SRC_ROOT);
    let server: Awaited<ReturnType<typeof createServer>> | null = null;
    try {
      server = await createServer({
        root: APP_BASIC_ROOT,
        cacheDir: path.join(root, "manual-runtime-cache"),
        configFile: false,
        plugins: [
          vinext({ projectRoot: APP_BASIC_ROOT, rsc: false }),
          rsc({ entries: RSC_ENTRIES }),
        ],
        server: { host: "127.0.0.1", port: 0 },
      });
      for (const environment of Object.values(server.config.environments)) {
        const includes = environment.optimizeDeps.include ?? [];
        expect(includes.some((id) => id.startsWith("react-server-dom-webpack/"))).toBe(false);
        expect(includes.some((id) => id.startsWith(`${RSDW_VENDOR_ALIAS}/`))).toBe(true);
      }

      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Expected a local dev address");
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Welcome to App Router");
    } finally {
      await server?.close();
      cwdSpy.mockRestore();
    }
  }, 30_000);
});
