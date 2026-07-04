import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("vinext package boundary", () => {
  it("does not bundle or export @vinext/cloudflare", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "packages/vinext/package.json"), "utf8"),
    ) as {
      exports?: Record<string, unknown>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packConfig = fs.readFileSync(path.join(root, "packages/vinext/vite.config.ts"), "utf8");
    const cdnCacheSource = fs.readFileSync(
      path.join(root, "packages/vinext/src/shims/cdn-cache.ts"),
      "utf8",
    );

    expect(packageJson.exports).not.toHaveProperty("./cloudflare");
    expect(packageJson.dependencies).not.toHaveProperty("@vinext/cloudflare");
    expect(packageJson.devDependencies).not.toHaveProperty("@vinext/cloudflare");
    expect(packConfig).not.toContain("@vinext/cloudflare");
    expect(cdnCacheSource).not.toMatch(/^import .*@vinext\/cloudflare/m);
  });

  it("rejects the removed deploy command instead of loading the Cloudflare deployer", () => {
    const cliSource = fs.readFileSync(path.join(root, "packages/vinext/src/cli.ts"), "utf8");

    expect(cliSource).not.toContain('from "@vinext/cloudflare/internal/deploy"');
    expect(cliSource).toContain("Error: `vinext deploy` has moved");
    expect(cliSource).toContain('case "deploy":\n    failRemovedDeployCommand();');
  });
});
