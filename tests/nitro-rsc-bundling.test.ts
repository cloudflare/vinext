import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

// A package's `react-server` export condition is only honoured when the RSC
// environment bundles the package. If Vite treats a node_modules dependency as
// external there, the host bundler (Nitro) resolves it later without the
// `react-server` condition and bundles the `default` branch instead.
async function resolveRscEnvironment(plugins: unknown[]) {
  const mainPlugin = vinext().find(
    // oxlint-disable-next-line typescript/no-explicit-any
    (p: any) => p.name === "vinext:config" && typeof p.config === "function",
  ) as any;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-rsc-"));
  try {
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await fs.mkdir(path.join(root, "app"), { recursive: true });
    await fs.writeFile(
      path.join(root, "app", "page.tsx"),
      `export default function Page() { return <p>hi</p>; }`,
    );
    await fs.writeFile(
      path.join(root, "app", "layout.tsx"),
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );
    const result = await mainPlugin.config({ root, build: {}, plugins }, { command: "build" });
    return result.environments.rsc;
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

describe("RSC environment dependency bundling under Nitro", () => {
  it("bundles node_modules dependencies so the react-server condition is honoured", async () => {
    const rsc = await resolveRscEnvironment([{ name: "nitro" }]);
    expect(rsc?.resolve?.noExternal).toBe(true);
  }, 15000);
});
