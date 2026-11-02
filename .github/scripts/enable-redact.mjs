// Adds TanStack Redact (https://tanstack.com/redact) after the existing plugins in
// an example's vite.config.ts so PR previews render with Redact in the browser.
// SSR and RSC keep native React. The config is edited in place because the
// deploy CLI text-scans vite.config.ts for its `cloudflare(...)` and `cache:` blocks.
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Usage: node enable-redact.mjs <example-directory>");

const configPath = path.resolve(root, "vite.config.ts");
const source = fs.readFileSync(configPath, "utf8");
const exportDefault = "export default defineConfig({";
if (source.split(exportDefault).length !== 2) {
  throw new Error(`Expected exactly one \`${exportDefault}\` in ${configPath}`);
}

fs.writeFileSync(
  configPath,
  [
    'import { redact as __redact } from "@tanstack/redact/vinext";',
    source.replace(exportDefault, "const __redactBaseConfig = defineConfig({"),
    "export default {",
    "  ...__redactBaseConfig,",
    "  plugins: [...(__redactBaseConfig.plugins ?? []), __redact()],",
    "};",
    "",
  ].join("\n"),
);
console.log(`Enabled TanStack Redact in ${path.relative(process.cwd(), configPath)}`);
