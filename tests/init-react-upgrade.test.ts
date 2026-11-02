import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { init } from "../packages/vinext/src/init.js";
import { createIsolatedFixture } from "./helpers.js";

// A create-next-app scaffold that pins React below the 19.3.1 floor of
// react-server-dom-webpack, so init has to upgrade it.
const fixture = path.resolve(import.meta.dirname, "fixtures/init-react-upgrade");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function readDependencies(root: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies;
}

async function runInit(install: boolean) {
  const root = await createIsolatedFixture(fixture, "vinext-init-react-upgrade-");
  roots.push(root);
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    output.push(args.join(" "));
  });
  try {
    await init({
      root,
      skipCheck: true,
      install,
      platform: "cloudflare",
      cloudflare: { dataCache: "none", cdnCache: "none", imageOptimization: "none" },
      // Write the specs npm saves for `npm install react@latest react-dom@latest`.
      _exec: (cmd) => {
        if (!cmd.includes('"react@latest"')) return;
        const pkgPath = path.join(root, "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        pkg.dependencies.react = "^19.3.1";
        pkg.dependencies["react-dom"] = "^19.3.1";
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      },
    });
  } finally {
    log.mockRestore();
  }
  return { root, output: output.join("\n") };
}

describe("vinext init React upgrade", () => {
  it("names the old and new specs of the React packages it upgrades", async () => {
    const { root, output } = await runInit(true);

    expect(readDependencies(root)).toMatchObject({ react: "^19.3.1", "react-dom": "^19.3.1" });
    expect(output).toContain(
      "    ✓ Upgraded react 19.2.4 → ^19.3.1\n    ✓ Upgraded react-dom 19.2.4 → ^19.3.1",
    );
  });

  it("names the specs it writes with --no-install", async () => {
    const { root, output } = await runInit(false);

    expect(readDependencies(root)).toMatchObject({ react: "latest", "react-dom": "latest" });
    expect(output).toContain(
      "    ✓ Upgraded react 19.2.4 → latest\n    ✓ Upgraded react-dom 19.2.4 → latest",
    );
    // The upgrades are not listed again as added entries.
    expect(output).toContain(
      "    ✓ Added dependencies to dependencies:\n      - vinext\n      - react-server-dom-webpack\n      - @vinext/cloudflare\n",
    );
  });
});
