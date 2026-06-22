/**
 * `vinext start` — start the production server.
 *
 * Serves the output of `vinext build`. The command's flags and help text are
 * both derived from the {@link CommandSpec} below.
 */

import path from "node:path";
import { defineCommand } from "../command.js";
import { loadDotenv } from "../../config/dotenv.js";

export const startCommand = defineCommand({
  name: "start",
  summary: "Start production server",
  description:
    "Serves the output from `vinext build`. Supports SSR, static files,\n" +
    "compression, and all middleware.\n" +
    'For output: "standalone", you can also run: node dist/standalone/server.js',
  args: {
    port: {
      type: "port",
      short: "p",
      valueHint: "port",
      description: "Port to listen on (default: 3000, or PORT env)",
    },
    hostname: {
      type: "string",
      short: "H",
      valueHint: "host",
      description: "Hostname to bind to",
      default: "0.0.0.0",
    },
  },
  async run({ values }) {
    loadDotenv({
      root: process.cwd(),
      mode: "production",
    });

    const port = values.port ?? parseInt(process.env.PORT ?? "3000", 10);
    const host = values.hostname;

    console.log(`\n  vinext start  (port ${port})\n`);

    const { startProdServer } = (await import(
      /* @vite-ignore */ "../../server/prod-server.js"
    )) as {
      startProdServer: (opts: { port: number; host: string; outDir: string }) => Promise<unknown>;
    };

    await startProdServer({
      port,
      host,
      outDir: path.resolve(process.cwd(), "dist"),
    });
  },
});
