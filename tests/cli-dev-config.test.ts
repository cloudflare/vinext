import { describe, expect, it } from "vite-plus/test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig, type Plugin, type ServerOptions } from "vite";
import {
  applyDevServerDefaults,
  createDevServerConfigPlugin,
  createDevServerLifecyclePlugin,
  normalizeDevServerHostname,
} from "../packages/vinext/src/cli-dev-config.js";
import { getLockfilePath } from "../packages/vinext/src/server/dev-lockfile.js";
import { isViteCliInvocation } from "../packages/vinext/src/utils/vite-cli-invocation.js";

describe("applyDevServerDefaults", () => {
  it("uses vinext defaults when neither config nor CLI flags specify values", () => {
    const server: ServerOptions = {};

    applyDevServerDefaults(server, {});

    expect(server).toMatchObject({ host: "localhost", port: 3000 });
  });

  it("preserves host and port from the Vite config", () => {
    const server: ServerOptions = { host: "dev.internal.test", port: 4321 };

    applyDevServerDefaults(server, {});

    expect(server).toMatchObject({ host: "dev.internal.test", port: 4321 });
  });

  it("lets explicit CLI flags override the Vite config", () => {
    const server: ServerOptions = { host: "dev.internal.test", port: 4321 };

    applyDevServerDefaults(server, { hostname: "0.0.0.0", port: 4000 });

    expect(server).toMatchObject({ host: "0.0.0.0", port: 4000 });
  });
});

describe("createDevServerConfigPlugin", () => {
  it("applies explicit CLI flags after user config hooks", async () => {
    const lateUserConfigPlugin: Plugin = {
      name: "test:late-user-config",
      enforce: "post",
      config: {
        order: "post",
        handler(config) {
          config.server ??= {};
          config.server.host = "late.example.test";
          config.server.port = 4999;
        },
      },
    };

    const config = await resolveConfig(
      {
        configFile: false,
        plugins: [
          lateUserConfigPlugin,
          createDevServerConfigPlugin({ hostname: "127.0.0.1", port: 4000 }),
        ],
      },
      "serve",
    );

    expect(config.server).toMatchObject({ host: "127.0.0.1", port: 4000 });
  });
});

describe("createDevServerLifecyclePlugin", () => {
  it("applies vinext's defaults to a direct Vite dev server", async () => {
    const config = await resolveConfig(
      { configFile: false, plugins: [createDevServerLifecyclePlugin()] },
      "serve",
    );

    expect(config.server).toMatchObject({ host: "localhost", port: 3000 });
  });

  it("preserves explicit Vite server settings", async () => {
    const config = await resolveConfig(
      {
        configFile: false,
        server: { host: "dev.example.test", port: 4173 },
        plugins: [createDevServerLifecyclePlugin()],
      },
      "serve",
    );

    expect(config.server).toMatchObject({ host: "dev.example.test", port: 4173 });
  });

  it("owns the dev lock for the lifetime of a direct Vite server", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-vite-dev-lock-"));
    const httpServer = new EventEmitter();
    const watcher = new EventEmitter();
    const plugin = createDevServerLifecyclePlugin();
    const configureServer = plugin.configureServer;
    if (typeof configureServer !== "function") throw new Error("configureServer hook missing");
    const previousArgv = process.argv;
    process.argv = [process.execPath, "/project/node_modules/vite/bin/vite.js", "dev"];

    try {
      await configureServer.call(
        {} as never,
        {
          config: {
            root,
            logger: { warn() {} },
            server: { host: "localhost", middlewareMode: false, port: 3000 },
          },
          httpServer,
          resolvedUrls: null,
          watcher,
        } as never,
      );

      expect(fs.existsSync(getLockfilePath(root))).toBe(true);
      watcher.emit("close");
      expect(fs.existsSync(getLockfilePath(root))).toBe(false);
    } finally {
      process.argv = previousArgv;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not lock programmatic Vite servers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-vite-api-no-lock-"));
    const plugin = createDevServerLifecyclePlugin();
    const configureServer = plugin.configureServer;
    if (typeof configureServer !== "function") throw new Error("configureServer hook missing");

    try {
      await configureServer.call(
        {} as never,
        {
          config: { root, server: { middlewareMode: false, port: 0 } },
        } as never,
      );
      expect(fs.existsSync(getLockfilePath(root))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isViteCliInvocation", () => {
  it("recognizes Vite and Vite+ dev and build commands", () => {
    expect(
      isViteCliInvocation("dev", ["node", "/app/node_modules/vite/bin/vite.js", "--port", "3000"]),
    ).toBe(true);
    expect(
      isViteCliInvocation("build", ["node", "/app/node_modules/vite/bin/vite.js", "build"]),
    ).toBe(true);
    expect(isViteCliInvocation("dev", ["node", "/usr/local/bin/vp", "dev"])).toBe(true);
    expect(isViteCliInvocation("build", ["node", "/usr/local/bin/vp", "build"])).toBe(true);
  });

  it("does not classify programmatic Vite consumers as CLI invocations", () => {
    expect(isViteCliInvocation("dev", ["node", "/app/node_modules/vitest/vitest.mjs"])).toBe(false);
    expect(isViteCliInvocation("build", ["node", "/app/scripts/build.mjs"])).toBe(false);
  });
});

describe("normalizeDevServerHostname", () => {
  it("normalizes Vite boolean host values for lockfile metadata", () => {
    expect(normalizeDevServerHostname(true)).toBe("0.0.0.0");
    expect(normalizeDevServerHostname(false)).toBe("localhost");
    expect(normalizeDevServerHostname(undefined)).toBe("localhost");
  });
});
