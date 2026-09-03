import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

type VinextPlugin = {
  name: string;
  config?: (config: unknown, env: { command: string }) => unknown;
};

async function readAppStrictModeDefine(nextConfigBody: string): Promise<string | undefined> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-app-strict-mode-"));
  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");

  try {
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
    await fsp.mkdir(path.join(tmpDir, "app"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    );
    await fsp.writeFile(
      path.join(tmpDir, "app", "page.tsx"),
      "export default function Page() { return null; }",
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), nextConfigBody);

    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as VinextPlugin[];
    const configPlugin = plugins.find(
      (plugin) => plugin.name === "vinext:config" && typeof plugin.config === "function",
    );
    expect(configPlugin).toBeDefined();

    const result = (await configPlugin!.config!(
      { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
      { command: "build" },
    )) as { define?: Record<string, string> };

    return result.define?.["process.env.__NEXT_STRICT_MODE_APP"];
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

describe("App Router reactStrictMode define", () => {
  it("enables Strict Mode by default", async () => {
    expect(await readAppStrictModeDefine("export default {};")).toBe("true");
  });

  it("enables Strict Mode when configured", async () => {
    expect(await readAppStrictModeDefine("export default { reactStrictMode: true };")).toBe("true");
  });

  it("disables Strict Mode when configured", async () => {
    expect(await readAppStrictModeDefine("export default { reactStrictMode: false };")).toBe(
      "false",
    );
  });
});
