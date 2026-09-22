import type { Plugin, ServerOptions, ViteDevServer } from "vite";
import { formatAlreadyRunningError, tryAcquireLockfile } from "./server/dev-lockfile.js";

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

export function configureDevServerLock(server: ViteDevServer): void {
  if (server.config.server.middlewareMode === true || process.env.VINEXT_NO_DEV_LOCK === "1") {
    return;
  }

  const root = server.config.root;
  const port = server.config.server.port ?? 3000;
  const hostname = normalizeDevServerHostname(server.config.server.host);
  const displayHostname = hostname === "0.0.0.0" ? "localhost" : hostname;
  const startedAt = Date.now();
  const acquired = tryAcquireLockfile({
    root,
    info: {
      pid: process.pid,
      port,
      hostname,
      appUrl: `http://${displayHostname}:${port}`,
      startedAt,
      cwd: root,
    },
  });
  if (!acquired.ok) {
    throw new Error(
      formatAlreadyRunningError({
        existing: acquired.existing,
        cwd: root,
        lockfilePath: acquired.lockfilePath,
      }),
    );
  }

  const lockfile = acquired.lockfile;
  const releaseLock = () => lockfile.release();
  const closeServer = server.close.bind(server);
  server.close = async () => {
    try {
      await closeServer();
    } finally {
      releaseLock();
    }
  };
  server.httpServer?.once("listening", () => {
    setImmediate(() => {
      const address = server.httpServer?.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const appUrl =
        server.resolvedUrls?.local[0]?.replace(/\/$/, "") ??
        `http://${displayHostname}:${actualPort}`;
      lockfile.update({
        pid: process.pid,
        port: actualPort,
        hostname,
        appUrl,
        startedAt,
        cwd: root,
      });
    });
  });
  server.httpServer?.once("close", releaseLock);
}
