import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { assertPluginRscVersion } from "../packages/vinext/src/utils/plugin-rsc-version.js";

let roots: string[] = [];

function installPluginRsc(version: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-plugin-rsc-version-"));
  roots.push(root);
  const dir = path.join(root, "node_modules", "@vitejs", "plugin-rsc");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@vitejs/plugin-rsc", version }),
  );
  const entry = path.join(dir, "dist", "index.js");
  fs.writeFileSync(entry, "");
  return entry;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("assertPluginRscVersion", () => {
  it("rejects installed versions without action-bound closure encryption", () => {
    expect(() => assertPluginRscVersion(installPluginRsc("0.5.34"))).toThrow(
      "vinext: App Router requires @vitejs/plugin-rsc 0.5.37 or newer (found 0.5.34).",
    );
  });

  it("returns the installed version from 0.5.37", () => {
    expect(assertPluginRscVersion(installPluginRsc("0.5.37"))).toBe("0.5.37");
    expect(assertPluginRscVersion(installPluginRsc("0.6.0"))).toBe("0.6.0");
  });
});
