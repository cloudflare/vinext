import type { Plugin, ServerOptions } from "vite";
import { formatAlreadyRunningError, tryAcquireLockfile } from "./server/dev-lockfile.js";
import { isViteCliInvocation } from "./utils/vite-cli-invocation.js";

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

/** Apply vinext's development defaults and lockfile behavior to `vite dev`. */
export function createDevServerLifecyclePlugin(): Plugin {
  return {
    name: "vinext:dev-server-lifecycle",
    enforce: "post",
    config: {
      order: "post",
      handler(config, environment) {
        if (environment.command !== "serve" || environment.isPreview) return;
        applyDevServerDefaults((config.server ??= {}), {});
      },
    },
    configureServer(server) {
      // Programmatic Vite servers own their own lifecycle and frequently run
      // concurrently against one fixture. The lock is specifically a CLI
      // affordance for `vite dev` processes.
      if (
        process.env.VINEXT_NO_DEV_LOCK === "1" ||
        server.config.server.middlewareMode ||
        !isViteCliInvocation("dev")
      ) {
        return;
      }

      const root = server.config.root;
      const port = server.config.server.port ?? 3000;
      const hostname = normalizeDevServerHostname(server.config.server.host);
      const displayHostname = hostname === "0.0.0.0" ? "localhost" : hostname;
      const startedAt = Date.now();
      let acquired: ReturnType<typeof tryAcquireLockfile>;
      try {
        acquired = tryAcquireLockfile({
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
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EACCES" && code !== "EROFS") throw error;
        server.config.logger.warn(
          `[vinext] Could not create the dev-server lockfile in ${root}; continuing without it.`,
        );
        return;
      }
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
      server.httpServer?.once("listening", () => {
        setTimeout(() => {
          const configuredPort = server.config.server.port ?? port;
          const configuredHostname = normalizeDevServerHostname(server.config.server.host);
          const resolved = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
          let actualPort = configuredPort;
          let appUrl =
            resolved ??
            `http://${configuredHostname === "0.0.0.0" ? "localhost" : configuredHostname}:${configuredPort}`;
          if (resolved) {
            try {
              const url = new URL(resolved);
              if (url.port) actualPort = Number.parseInt(url.port, 10);
            } catch {
              appUrl = `http://${configuredHostname}:${configuredPort}`;
            }
          }
          lockfile.update({
            pid: process.pid,
            port: actualPort,
            hostname: configuredHostname,
            appUrl,
            startedAt,
            cwd: root,
          });
        }, 0);
      });
      const release = () => lockfile.release();
      server.httpServer?.once("close", release);
      server.watcher.once("close", release);
    },
  };
}
