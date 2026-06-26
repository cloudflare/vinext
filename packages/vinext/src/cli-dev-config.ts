import type { Plugin, ServerOptions } from "vite";

export type DevServerCliOptions = {
  port?: number;
  hostname?: string;
};

export function applyDevServerDefaults(server: ServerOptions, options: DevServerCliOptions): void {
  server.port = options.port ?? server.port ?? 3000;
  server.host = options.hostname ?? server.host ?? "localhost";
}

export function createDevServerConfigPlugin(options: DevServerCliOptions): Plugin {
  return {
    name: "vinext:dev-server-config",
    // Both levels are required: `enforce` places this after the user's normal
    // plugins, while the hook `order` places it after their config handlers.
    enforce: "post",
    config: {
      order: "post",
      handler(config) {
        const server = (config.server ??= {});
        applyDevServerDefaults(server, options);
      },
    },
  };
}

export function normalizeDevServerHostname(host: string | boolean | undefined): string {
  if (typeof host === "string") return host;
  return host === true ? "0.0.0.0" : "localhost";
}
