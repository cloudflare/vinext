#!/usr/bin/env node

/**
 * vinext CLI
 *
 * Drop-in replacement for `next` CLI commands:
 *   vinext dev    -> Starts Vite dev server with vinext plugin
 *   vinext build  -> Builds for production (client + SSR)
 *   vinext start  -> Starts the production server
 */
import { createServer, build } from "vite";
import vinext from "vinext";
import path from "node:path";

const command = process.argv[2];
const args = process.argv.slice(3);

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
    } else if (arg.startsWith("-p")) {
      // -p <port> shorthand
      result["port"] = args[++i];
    }
  }
  return result;
}

async function dev() {
  const parsed = parseArgs(args);
  const port = parseInt(parsed.port ?? "3000");
  const host = parsed.hostname ?? "localhost";

  console.log(`\n  vinext dev\n`);

  const server = await createServer({
    root: process.cwd(),
    plugins: [vinext()],
    server: {
      port,
      host,
    },
  });

  await server.listen();
  server.printUrls();
}

async function buildApp() {
  console.log(`\n  vinext build\n`);
  const appRoot = process.cwd();

  // Step 1: Client build — produces hashed page chunks + SSR manifest
  // Uses the virtual client entry which imports all pages via dynamic import,
  // enabling Vite to code-split each page into its own chunk.
  console.log("  Building client...");
  await build({
    root: appRoot,
    plugins: [vinext()],
    build: {
      outDir: "dist/client",
      ssrManifest: true,
      rollupOptions: {
        input: "virtual:vinext-client-entry",
      },
    },
  });

  // Step 2: SSR build — produces the server entry bundle
  console.log("  Building server...");
  await build({
    root: appRoot,
    plugins: [vinext()],
    build: {
      outDir: "dist/server",
      ssr: "virtual:vinext-server-entry",
      rollupOptions: {
        output: {
          entryFileNames: "entry.js",
        },
      },
    },
  });

  console.log("\n  Build complete. Run `vinext start` to start the production server.\n");
}

async function start() {
  const parsed = parseArgs(args);
  const port = parseInt(parsed.port ?? process.env.PORT ?? "3000");
  const host = parsed.hostname ?? "0.0.0.0";

  console.log(`\n  vinext start\n`);

  // Import prod server dynamically
  const { startProdServer } = await import(
    /* @vite-ignore */ "vinext/server/prod-server"
  ) as { startProdServer: (opts: { port: number; host: string; outDir: string }) => Promise<unknown> };

  await startProdServer({
    port,
    host,
    outDir: path.resolve(process.cwd(), "dist"),
  });
}

switch (command) {
  case "dev":
    dev().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "build":
    buildApp().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "start":
    start().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  default:
    console.log(`
  vinext - Run Next.js apps on Vite

  Usage:
    vinext dev     Start development server
    vinext build   Build for production
    vinext start   Start production server

  Options:
    --port <port>      Port to listen on (default: 3000)
    --hostname <host>  Hostname to bind to (default: localhost for dev, 0.0.0.0 for start)
    -p <port>          Shorthand for --port
`);
    if (command) {
      console.error(`  Unknown command: ${command}\n`);
      process.exit(1);
    }
    break;
}
