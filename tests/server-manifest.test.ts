import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import { readServerManifest } from "../packages/vinext/src/build/server-manifest.js";

type WriteBundleHook = {
  writeBundle: {
    handler: (this: { environment: { name: string } }, options: { dir?: string }) => Promise<void>;
  };
};

function serverManifestPlugin(): WriteBundleHook {
  const plugin = (vinext() as Array<{ name?: string }>)
    .flat(Infinity as 1)
    .find((candidate) => candidate?.name === "vinext:server-manifest");
  if (!plugin) throw new Error("vinext:server-manifest plugin not found");
  return plugin as unknown as WriteBundleHook;
}

async function writeManifest(plugin: WriteBundleHook, envName: string, outDir: string) {
  await plugin.writeBundle.handler.call({ environment: { name: envName } }, { dir: outDir });
}

describe("vinext:server-manifest", () => {
  it("preserves hasServerActions written by a different builder's rsc environment", async () => {
    // Hybrid CLI builds run the Pages Router SSR bundle as a second builder
    // with a separate vinext() closure (cli.ts), whose ssr environment writes
    // vinext-server.json after the App Router build recorded hasServerActions
    // under a different prerender secret. Dropping the flag there makes the
    // prerender publisher assume actions exist and silently skip visible HTML
    // publication for every hybrid CLI build.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-server-manifest-"));
    fs.writeFileSync(
      path.join(outDir, "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "from-the-app-router-builder", hasServerActions: false }),
    );

    await writeManifest(serverManifestPlugin(), "ssr", outDir);

    const manifest = readServerManifest(outDir);
    expect(manifest?.hasServerActions).toBe(false);
    // The second builder still rotates the prerender secret with its own.
    expect(manifest?.prerenderSecret).not.toBe("from-the-app-router-builder");
    expect(manifest?.prerenderSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits hasServerActions when the ssr environment has nothing to preserve", async () => {
    // Absence must stay absent (readers treat it as "actions may exist");
    // the ssr environment must not invent a value it cannot know.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-server-manifest-"));

    await writeManifest(serverManifestPlugin(), "ssr", outDir);

    const manifest = readServerManifest(outDir);
    expect(manifest?.hasServerActions).toBeUndefined();
    expect(manifest?.prerenderSecret).toMatch(/^[0-9a-f]{64}$/);
  });
});
