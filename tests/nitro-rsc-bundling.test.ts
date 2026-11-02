import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

// A package's `react-server` export condition is only honoured when the RSC
// environment bundles the package. If Vite treats a node_modules dependency as
// external there, the host bundler (Nitro) resolves it later without the
// `react-server` condition and bundles the `default` branch instead.
async function resolveRscEnvironment(plugins: unknown[], command: "build" | "serve" = "build") {
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
    const result = await mainPlugin.config({ root, build: {}, plugins }, { command });
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

  // The RSC environment's blanket `noExternal: true` would otherwise also sweep
  // Next's default server-external packages into the bundle -- breaking any
  // package whose own code assumes it is still sitting inside node_modules (a
  // native addon's path-discovery helper) or that is not safe to inline into a
  // single compiled chunk (a bare top-level `import.meta`). `external` carves
  // those packages back out, same as the non-Nitro branch below does.
  it("keeps Next's default server-external packages external even while bundling everything else", async () => {
    const rsc = await resolveRscEnvironment([{ name: "nitro" }]);
    expect(rsc?.resolve?.noExternal).toBe(true);
    expect(rsc?.resolve?.external).toContain("sqlite3");
    expect(rsc?.resolve?.external).toContain("typescript");
  }, 15000);

  // Nitro dev serve otherwise leaves the rsc environment with plugin-rsc's
  // own noExternal package list, externalizing `next` before vinext's
  // resolveId shim can intercept it (#3608). The full-bundling fix above
  // already covers that case except when Cloudflare's plugin is also
  // present, where the full-bundling branch is intentionally skipped.
  it("keeps next in Vite's pipeline in Nitro dev serve when Cloudflare's plugin is also present", async () => {
    const rsc = await resolveRscEnvironment(
      [{ name: "nitro" }, { name: "vite-plugin-cloudflare" }],
      "serve",
    );
    expect(rsc?.resolve?.noExternal).toEqual(["next"]);
  }, 15000);

  it("still fully bundles in Nitro dev serve without Cloudflare's plugin", async () => {
    const rsc = await resolveRscEnvironment([{ name: "nitro" }], "serve");
    expect(rsc?.resolve?.noExternal).toBe(true);
  }, 15000);
});
