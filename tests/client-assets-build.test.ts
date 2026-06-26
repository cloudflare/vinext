import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function writeFile(file: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

describe("client asset sidecar builds", () => {
  it("keeps App Router metadata at the stable root of nested custom server outputs", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-client-assets-build-"));
    const outRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-client-assets-out-"));
    try {
      await fs.symlink(ROOT_NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");
      await writeFile(
        path.join(fixtureRoot, "package.json"),
        `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "layout.tsx"),
        `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "page.tsx"),
        `"use client";
import { useState } from "react";
export default function Page() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`,
      );

      const serverRoot = path.join(outRoot, "custom", "server");
      const rscOutDir = path.join(serverRoot, "rsc");
      const ssrOutDir = serverRoot;
      const clientOutDir = path.join(outRoot, "custom", "client");
      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ appDir: fixtureRoot, rscOutDir, ssrOutDir, clientOutDir })],
      });
      await builder.buildApp();

      const sidecar = await fs.readFile(path.join(serverRoot, "vinext-client-assets.js"), "utf8");
      expect(sidecar).toContain('"appBootstrapPreinitModules"');
      expect(sidecar).not.toBe("export default {};\n");
      await expect(fs.access(path.join(rscOutDir, "vinext-client-assets.js"))).rejects.toThrow();

      const rscEntry = await fs.readFile(path.join(rscOutDir, "index.js"), "utf8");
      expect(rscEntry).toContain("../vinext-client-assets.js");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
      await fs.rm(outRoot, { recursive: true, force: true });
    }
  });
});
