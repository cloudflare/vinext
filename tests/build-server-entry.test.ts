import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolveBuiltRscEntryPath } from "../packages/vinext/src/build/server-entry.js";

/**
 * The App handler must be resolved even when the deployment host owns
 * `index.js`: a multi-stage Cloudflare build writes its Worker entry there, and
 * that file imports `cloudflare:*`, which cannot load on Node. Resolving it is
 * what made `vinext build --prerender-all` die with a raw ESM loader error
 * before rendering anything. Refs cloudflare/vinext#3318
 */
describe("resolveBuiltRscEntryPath", () => {
  const dirs: string[] = [];

  function writeServerDir(key: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-rsc-entry-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, ".vite"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app-handler.js"), "export default () => null;\n");
    fs.writeFileSync(path.join(dir, "index.js"), "export default {};\n");
    fs.writeFileSync(
      path.join(dir, ".vite", "manifest.json"),
      JSON.stringify({ [key]: { file: "app-handler.js", src: key } }),
    );
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("resolves the bare virtual entry key", () => {
    const dir = writeServerDir("virtual:vinext-rsc-entry");

    expect(resolveBuiltRscEntryPath(dir)).toBe(path.join(dir, "app-handler.js"));
  });

  it("resolves a root-prefixed virtual entry key", () => {
    // Vite prefixes virtual module ids with the project root when the build root
    // is not the process cwd, so the manifest key arrives as
    // `<root>/virtual:vinext-rsc-entry`.
    const dir = writeServerDir("../../projects/site/virtual:vinext-rsc-entry");

    expect(resolveBuiltRscEntryPath(dir)).toBe(path.join(dir, "app-handler.js"));
  });
});
