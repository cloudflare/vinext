/**
 * `vinext dev` — start the development server (Vite).
 *
 * The command's flags and help text are both derived from the {@link CommandSpec}
 * below; there is no separate help template to keep in sync.
 */

import { defineCommand } from "../command.js";
import {
  applyViteConfigCompatibility,
  buildViteConfig,
  getViteVersion,
  loadVite,
} from "../runtime.js";
import { loadDotenv } from "../../config/dotenv.js";
import {
  type DevLockfile,
  formatAlreadyRunningError,
  tryAcquireLockfile,
} from "../../server/dev-lockfile.js";

export const devCommand = defineCommand({
  name: "dev",
  summary: "Start development server",
  description: "Start the Vite-powered development server for your Next.js app.",
  args: {
    port: {
      type: "port",
      short: "p",
      valueHint: "port",
      description: "Port to listen on",
      default: 3000,
    },
    hostname: {
      type: "string",
      short: "H",
      valueHint: "host",
      description: "Hostname to bind to",
      default: "localhost",
    },
    turbopack: {
      type: "boolean",
      hidden: true,
      description: "Accepted for compatibility (no-op, Vite is always used)",
    },
    "experimental-https": {
      type: "boolean",
      hidden: true,
      description: "Accepted for `next dev` compatibility (no-op)",
    },
  },
  examples: [
    { command: "vinext dev", description: "Start dev server on port 3000" },
    { command: "vinext dev -p 4000", description: "Start dev server on port 4000" },
  ],
  async run({ values }) {
    const port = values.port;
    const host = values.hostname;

    loadDotenv({
      root: process.cwd(),
      mode: "development",
    });

    // Ensure "type": "module" in package.json before Vite loads vite.config.ts.
    // Without this, Vite bundles the config as CJS and tries require() on pure-ESM
    // packages like @cloudflare/vite-plugin, which fails on Node 22.
    applyViteConfigCompatibility(process.cwd());

    const vite = await loadVite();

    // Acquire the dev lock file. If another live `vinext dev` is running in this
    // directory, print an actionable error (PID + URL) and exit. This is
    // especially useful for AI coding agents, which frequently attempt to start
    // a dev server without knowing one is already running.
    //
    // Disabled when VINEXT_NO_DEV_LOCK is set (escape hatch for unusual setups).
    let lockfile: DevLockfile | undefined;
    // Capture the acquisition timestamp so we can preserve it across the
    // post-listen update(). `startedAt` is meant to reflect when this process
    // started, not when the URL was resolved.
    const startedAt = Date.now();
    if (process.env.VINEXT_NO_DEV_LOCK !== "1") {
      const root = process.cwd();
      // Substitute "localhost" for wildcard binds so the URL is actually
      // clickable when surfaced in the lock file before server.listen() has
      // had a chance to resolve the real URL.
      const initialDisplayHost = host === "0.0.0.0" ? "localhost" : host;
      const acquired = tryAcquireLockfile({
        root,
        info: {
          pid: process.pid,
          port,
          hostname: host,
          appUrl: `http://${initialDisplayHost}:${port}`,
          startedAt,
          cwd: root,
        },
      });
      if (!acquired.ok) {
        console.error(
          "\n  " +
            formatAlreadyRunningError({
              existing: acquired.existing,
              cwd: root,
              lockfilePath: acquired.lockfilePath,
            }).replace(/\n/g, "\n  ") +
            "\n",
        );
        process.exit(1);
      }
      lockfile = acquired.lockfile;
    }

    console.log(`\n  vinext dev  (Vite ${getViteVersion()})\n`);

    const config = buildViteConfig({
      server: { port, host },
    });

    // If anything between here and the first successful listen() throws (e.g.
    // strictPort and the port is taken), release the lock immediately so we
    // don't leave a misleading "server running" entry behind in the brief
    // window before the exit handler runs. The exit handler still serves as
    // a safety net for unexpected exit paths.
    let server;
    try {
      server = await vite.createServer(config);
      await server.listen();
    } catch (err) {
      lockfile?.release();
      throw err;
    }
    server.printUrls();

    // Once the server is actually listening, the port may have changed (e.g.
    // Vite picked a free port if the requested one was in use). Update the
    // lock file so other tools see the right port/URL.
    //
    // Prefer Vite's resolvedUrls.local[0] because it handles wildcard binds
    // (e.g. host "0.0.0.0") by substituting "localhost" so the URL is
    // actually clickable. Fall back to httpServer.address() if Vite didn't
    // populate resolvedUrls for some reason.
    if (lockfile) {
      const resolved = server.resolvedUrls?.local[0];
      let actualPort = port;
      let appUrl: string;
      if (resolved) {
        appUrl = resolved.replace(/\/$/, "");
        try {
          const parsedUrl = new URL(appUrl);
          actualPort = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : actualPort;
        } catch {
          // ignore — keep requested port
        }
      } else {
        const address = server.httpServer?.address();
        actualPort = typeof address === "object" && address ? address.port : port;
        appUrl = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}`;
      }
      lockfile.update({
        pid: process.pid,
        port: actualPort,
        hostname: host,
        appUrl,
        // Preserve the original acquire-time startedAt rather than resetting
        // to "now". startedAt represents when the process started.
        startedAt,
        cwd: process.cwd(),
      });
    }
  },
});
