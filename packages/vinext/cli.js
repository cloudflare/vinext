#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distCli = path.join(__dirname, "dist", "cli.js");

if (!fs.existsSync(distCli)) {
  // Avoid pnpm/yarn linking warnings in workspace dev installs.
  // The published package runs build in prepack so dist/cli.js will exist.
  console.error(
    "vinext: missing build output at packages/vinext/dist/cli.js\n" +
      "Run: pnpm --filter vinext run build\n"
  );
  process.exit(1);
}

// Re-export to built CLI
await import(url.pathToFileURL(distCli).toString());
