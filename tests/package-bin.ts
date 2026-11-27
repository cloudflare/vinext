import fs from "node:fs";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Resolves the JavaScript file that `pkg`'s `name` bin runs, as installed for
 * `root`, to spawn with `process.execPath`. On Windows, `node_modules/.bin`
 * holds shell and `.cmd` wrappers that can't be spawned without a shell.
 */
export function packageBin(root: string, pkg: string, name = pkg): string {
  const manifestPath = findPackageJSON(pkg, pathToFileURL(path.join(root, "package.json")))!;
  const { bin } = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    bin: string | Record<string, string>;
  };
  return path.resolve(path.dirname(manifestPath), typeof bin === "string" ? bin : bin[name]);
}
