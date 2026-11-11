import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const cliPath = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// Runs `vinext typegen` on an App Router project whose next.config records the
// NODE_ENV it is loaded under and the NODE_ENV its redirects callback sees.
function readNodeEnvFromTypegen(nodeEnv: "test" | undefined): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-typegen-node-env-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(root, "app/page.tsx"),
    "export default function Page() { return null; }\n",
  );
  fs.writeFileSync(
    path.join(root, "next.config.mjs"),
    [
      'import fs from "node:fs";',
      "const loadNodeEnv = String(process.env.NODE_ENV);",
      "export default {",
      "  async redirects() {",
      '    fs.writeFileSync("node-env.txt", `${loadNodeEnv}:${process.env.NODE_ENV}`);',
      "    return [];",
      "  },",
      "};",
      "",
    ].join("\n"),
  );

  const env = { ...process.env };
  if (nodeEnv === undefined) Reflect.deleteProperty(env, "NODE_ENV");
  else env.NODE_ENV = nodeEnv;
  const result = spawnSync(process.execPath, [cliPath, "typegen"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`vinext typegen failed:\n${result.stderr}`);
  return fs.readFileSync(path.join(root, "node-env.txt"), "utf8");
}

describe("vinext typegen NODE_ENV", () => {
  // `next typegen` defaults NODE_ENV to production and keeps a caller's value.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/bin/next.ts
  it("loads next.config and its callbacks with NODE_ENV=production by default", () => {
    expect(readNodeEnvFromTypegen(undefined)).toBe("production:production");
  }, 20_000);

  it("keeps the caller's NODE_ENV", () => {
    expect(readNodeEnvFromTypegen("test")).toBe("test:test");
  }, 20_000);
});
