import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolveSwcHelperFromNext } from "../packages/vinext/src/plugins/swc-helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-swc-helpers-"));
  tempDirs.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true }));
  return root;
}

describe("SWC helper resolution", () => {
  it("resolves helpers nested under next/node_modules", () => {
    // Ported from Next.js: test/e2e/handle-non-hoisted-swc-helpers/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/handle-non-hoisted-swc-helpers/index.test.ts
    const root = createProject();
    const nextDir = path.join(root, "node_modules", "next");
    const helperDir = path.join(nextDir, "node_modules", "@swc", "helpers");
    const helperFile = path.join(helperDir, "esm", "_object_spread.js");

    fs.mkdirSync(path.dirname(helperFile), { recursive: true });
    fs.writeFileSync(path.join(nextDir, "package.json"), JSON.stringify({ name: "next" }));
    fs.writeFileSync(
      path.join(helperDir, "package.json"),
      JSON.stringify({
        name: "@swc/helpers",
        exports: {
          "./_/_object_spread": "./esm/_object_spread.js",
        },
      }),
    );
    fs.writeFileSync(helperFile, "export default function objectSpread() {}\n");

    expect(resolveSwcHelperFromNext(root, "@swc/helpers/_/_object_spread")).toBe(
      fs.realpathSync(helperFile),
    );
  });

  it("ignores non-helper specifiers", () => {
    const root = createProject();

    expect(resolveSwcHelperFromNext(root, "react")).toBeNull();
  });
});
