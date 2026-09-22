import fs from "node:fs";
import { toSlash } from "pathslash";
import type { Plugin, ServerOptions, ViteDevServer } from "vite";
import { formatAlreadyRunningError, tryAcquireLockfile } from "./server/dev-lockfile.js";
import { isViteCliInvocation } from "./utils/vite-cli-invocation.js";

type ActiveDevServerLock = {
  lockfile: Extract<ReturnType<typeof tryAcquireLockfile>, { ok: true }>["lockfile"];
  restarting: boolean;
  servers: number;
  startedAt: number;
};

const activeDevServerLocks = new Map<string, ActiveDevServerLock>();
let devInvocationRoot: string | undefined;

export const VINEXT_DEV_RESTART_CONFIG = "__vinextDevRestart";

function normalizeDevLifecycleRoot(root: string): string {
  try {
    return toSlash(fs.realpathSync.native(root));
  } catch {
    return root;
  }
}

export function claimViteCliDevInvocation(root: string, isRestart = false): boolean {
  root = normalizeDevLifecycleRoot(root);
  if (!isViteCliInvocation("dev")) return false;
  if (devInvocationRoot === undefined) {
    devInvocationRoot = root;
    return true;
  }
  if (!isRestart) return false;
  devInvocationRoot = root;
  return true;
}

export type DevServerCliOptions = {
  port?: number;
  hostname?: string;
};

export function applyDevServerDefaults(server: ServerOptions, options: DevServerCliOptions): void {
  server.port = options.port ?? server.port ?? 3000;
  server.host = options.hostname ?? server.host ?? "localhost";
}

export function createDevServerLifecyclePlugin(
  options: DevServerCliOptions,
  isEnabled: () => boolean,
): Plugin {
  return {
    name: "vinext:dev-server-lifecycle",
    // Both levels are required: `enforce` places this after the user's normal
    // plugins, while the hook `order` places it after their config handlers.
    enforce: "post",
    config: {
      order: "post",
      handler(config) {
        if (!isEnabled() || config.server?.middlewareMode) return;
        const server = (config.server ??= {});
        applyDevServerDefaults(server, options);
      },
    },
    configureServer: {
      order: "post",
      handler(server) {
        if (!isEnabled()) return;
        if (!server.config.server.middlewareMode) {
          if (options.port !== undefined) server.config.server.port = options.port;
          if (options.hostname !== undefined) server.config.server.host = options.hostname;
        }
        configureDevServerLifecycle(server);
      },
    },
  };
}

// Kept while the legacy CLI still imports this helper. The thin-proxy layer
// removes both together.
export function createDevServerConfigPlugin(options: DevServerCliOptions): Plugin {
  return createDevServerLifecyclePlugin(options, () => true);
}

export function normalizeDevServerHostname(host: string | boolean | undefined): string {
  if (typeof host === "string") return host;
  return host === true ? "0.0.0.0" : "localhost";
}

function configureDevServerLifecycle(server: ViteDevServer): void {
  const root = normalizeDevLifecycleRoot(server.config.root);
  let activeLock: ActiveDevServerLock | undefined;
  let released = false;
  const releaseLock = () => {
    if (released) return;
    released = true;
    if (!activeLock) return;
    activeLock.servers--;
    if (activeLock.servers > 0 || activeLock.restarting) return;
    activeLock.lockfile.release();
    if (activeDevServerLocks.get(root) === activeLock) activeDevServerLocks.delete(root);
  };
  const releaseLifecycle = () => {
    releaseLock();
    if (!activeDevServerLocks.get(root)?.restarting && devInvocationRoot === root) {
      devInvocationRoot = undefined;
    }
  };
  const closeServer = server.close.bind(server);
  server.close = async () => {
    try {
      await closeServer();
    } finally {
      releaseLifecycle();
    }
  };
  const restartServer = server.restart.bind(server);
  server.restart = async (forceOptimize?: boolean) => {
    const restartingLock = activeDevServerLocks.get(root);
    if (restartingLock) restartingLock.restarting = true;
    const inlineConfig = server.config.inlineConfig as typeof server.config.inlineConfig & {
      [VINEXT_DEV_RESTART_CONFIG]?: true;
    };
    const previousRestartMarker = inlineConfig[VINEXT_DEV_RESTART_CONFIG];
    inlineConfig[VINEXT_DEV_RESTART_CONFIG] = true;
    try {
      await restartServer(forceOptimize);
    } finally {
      if (previousRestartMarker) inlineConfig[VINEXT_DEV_RESTART_CONFIG] = previousRestartMarker;
      else delete inlineConfig[VINEXT_DEV_RESTART_CONFIG];
      devInvocationRoot = normalizeDevLifecycleRoot(server.config.root);
      if (restartingLock) {
        restartingLock.restarting = false;
        if (restartingLock.servers === 0) {
          restartingLock.lockfile.release();
          if (activeDevServerLocks.get(root) === restartingLock) {
            activeDevServerLocks.delete(root);
          }
        }
      }
    }
  };
  const listenServer = server.listen.bind(server);
  server.listen = async (port?: number, isRestart?: boolean) => {
    if (server.config.server.middlewareMode || process.env.VINEXT_NO_DEV_LOCK === "1") {
      return listenServer(port, isRestart);
    }
    const configuredPort = port ?? server.config.server.port ?? 3000;
    const hostname = normalizeDevServerHostname(server.config.server.host);
    const displayHostname = hostname === "0.0.0.0" ? "localhost" : hostname;
    activeLock = activeDevServerLocks.get(root);
    if (!activeLock?.restarting) {
      const startedAt = Date.now();
      const acquired = tryAcquireLockfile({
        root,
        info: {
          pid: process.pid,
          port: configuredPort,
          hostname,
          appUrl: `http://${displayHostname}:${configuredPort}`,
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
      activeLock = { lockfile: acquired.lockfile, restarting: false, servers: 0, startedAt };
      activeDevServerLocks.set(root, activeLock);
    }
    activeLock.servers++;
    try {
      return await listenServer(port, isRestart);
    } catch (error) {
      releaseLifecycle();
      throw error;
    }
  };
  server.httpServer?.once("listening", () => {
    if (!activeLock) return;
    const port = server.config.server.port ?? 3000;
    const hostname = normalizeDevServerHostname(server.config.server.host);
    const displayHostname = hostname === "0.0.0.0" ? "localhost" : hostname;
    const lock = activeLock;
    setImmediate(() => {
      if (released) return;
      const address = server.httpServer?.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const appUrl =
        server.resolvedUrls?.local[0]?.replace(/\/$/, "") ??
        `http://${displayHostname}:${actualPort}`;
      lock.lockfile.update({
        pid: process.pid,
        port: actualPort,
        hostname,
        appUrl,
        startedAt: lock.startedAt,
        cwd: root,
      });
    });
  });
  server.httpServer?.once("close", releaseLifecycle);
}
