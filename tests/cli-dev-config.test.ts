import { describe, expect, it } from "vite-plus/test";
import { resolveConfig, type Plugin, type ServerOptions } from "vite";
import {
  applyDevServerDefaults,
  createDevServerConfigPlugin,
  normalizeDevServerHostname,
} from "../packages/vinext/src/cli-dev-config.js";

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

describe("normalizeDevServerHostname", () => {
  it("normalizes Vite boolean host values for lockfile metadata", () => {
    expect(normalizeDevServerHostname(true)).toBe("0.0.0.0");
    expect(normalizeDevServerHostname(false)).toBe("localhost");
    expect(normalizeDevServerHostname(undefined)).toBe("localhost");
  });
});
