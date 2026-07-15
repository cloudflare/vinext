import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";
import { withEnvVar } from "./env-test-helpers.js";

const tempRoots: string[] = [];

type VinextConfigPlugin = {
  config?: (
    config: { plugins: unknown[]; root: string },
    env: { command: "build"; mode: "production" },
  ) => Promise<{ define: Record<string, string> }> | { define: Record<string, string> };
  name: string;
};

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cf-rsc-transport-config-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "pages/index.tsx"),
    `export default function Home() { return <h1>Home</h1>; }\n`,
  );
  return root;
}

function findConfigPlugin(): VinextConfigPlugin {
  const plugins = vinext() as VinextConfigPlugin[];
  const configPlugin = plugins.find(
    (plugin) => plugin.name === "vinext:config" && typeof plugin.config === "function",
  );
  if (!configPlugin) throw new Error("vinext:config plugin not found");
  return configPlugin;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Cloudflare static RSC transport config", () => {
  it("uses the selected Wrangler environment when defining client RSC transport", async () => {
    const root = createTempRoot();
    fs.writeFileSync(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        assets: {
          binding: "ASSETS",
          directory: "dist/client",
          not_found_handling: "none",
        },
        env: {
          preview: {
            assets: {
              not_found_handling: "single-page-application",
            },
          },
        },
      }),
    );

    await withEnvVar("CLOUDFLARE_ENV", "preview", async () => {
      const result = await findConfigPlugin().config!(
        {
          root,
          plugins: [{ name: "vite-plugin-cloudflare" }],
        },
        { command: "build", mode: "production" },
      );

      expect(result.define["process.env.__VINEXT_CLOUDFLARE_RSC_TRANSPORT"]).toBe(
        JSON.stringify("false"),
      );
    });
  });

  it('disables client RSC transport for output: "export" builds', async () => {
    // Export builds write plain `about.rsc` files next to the HTML and the
    // Cloudflare publisher never emits the reserved transport assets, so the
    // client must keep requesting RSC at the public route URL.
    const root = createTempRoot();
    fs.writeFileSync(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        assets: { binding: "ASSETS", directory: "dist/client", not_found_handling: "none" },
      }),
    );

    const enabled = await findConfigPlugin().config!(
      { root, plugins: [{ name: "vite-plugin-cloudflare" }] },
      { command: "build", mode: "production" },
    );
    expect(enabled.define["process.env.__VINEXT_CLOUDFLARE_RSC_TRANSPORT"]).toBe(
      JSON.stringify("true"),
    );

    fs.writeFileSync(path.join(root, "next.config.mjs"), `export default { output: "export" };\n`);
    const exported = await findConfigPlugin().config!(
      { root, plugins: [{ name: "vite-plugin-cloudflare" }] },
      { command: "build", mode: "production" },
    );
    expect(exported.define["process.env.__VINEXT_CLOUDFLARE_RSC_TRANSPORT"]).toBe(
      JSON.stringify("false"),
    );
  });

  it("disables client RSC transport when only a wrangler.toml config exists", async () => {
    const root = createTempRoot();
    fs.writeFileSync(
      path.join(root, "wrangler.toml"),
      `[assets]\ndirectory = "dist/client"\nnot_found_handling = "single-page-application"\n`,
    );

    const result = await findConfigPlugin().config!(
      {
        root,
        plugins: [{ name: "vite-plugin-cloudflare" }],
      },
      { command: "build", mode: "production" },
    );

    expect(result.define["process.env.__VINEXT_CLOUDFLARE_RSC_TRANSPORT"]).toBe(
      JSON.stringify("false"),
    );
  });

  it("disables client RSC transport when only a cloudflare.config.ts config exists", async () => {
    const root = createTempRoot();
    fs.writeFileSync(
      path.join(root, "cloudflare.config.ts"),
      `export default { assets: { directory: "dist/client" } };\n`,
    );

    const result = await findConfigPlugin().config!(
      {
        root,
        plugins: [{ name: "vite-plugin-cloudflare" }],
      },
      { command: "build", mode: "production" },
    );

    expect(result.define["process.env.__VINEXT_CLOUDFLARE_RSC_TRANSPORT"]).toBe(
      JSON.stringify("false"),
    );
  });
});
