/**
 * Tests for assetPrefix support in next.config resolution.
 *
 * Ported from Next.js: test/unit/next-config-output-export.test.ts (conceptually)
 * https://github.com/vercel/next.js/blob/canary/test/unit/next-config-output-export.test.ts
 *
 * Verifies:
 *   - resolveNextConfig propagates assetPrefix with trailing slash stripped
 *   - assetPrefix defaults to basePath when assetPrefix is empty and basePath is set
 *   - explicit assetPrefix is NOT overridden by basePath
 *   - null config defaults assetPrefix to ""
 */
import { describe, expect, it } from "vitest";
import { type NextConfig, resolveNextConfig } from "../packages/vinext/src/config/next-config.js";

describe("assetPrefix — resolveNextConfig", () => {
  it("resolves assetPrefix from next.config and strips trailing slash", async () => {
    const config: NextConfig = { assetPrefix: "https://cdn.example.com/" };
    const resolved = await resolveNextConfig(config);
    expect(resolved.assetPrefix).toBe("https://cdn.example.com");
  });

  it("resolves assetPrefix without trailing slash unchanged", async () => {
    const config: NextConfig = { assetPrefix: "https://cdn.example.com" };
    const resolved = await resolveNextConfig(config);
    expect(resolved.assetPrefix).toBe("https://cdn.example.com");
  });

  it("defaults assetPrefix to basePath when assetPrefix is empty and basePath is set", async () => {
    const config: NextConfig = { basePath: "/app" };
    const resolved = await resolveNextConfig(config);
    expect(resolved.basePath).toBe("/app");
    expect(resolved.assetPrefix).toBe("/app");
  });

  it("does NOT inherit basePath when assetPrefix is explicitly set", async () => {
    const config: NextConfig = {
      basePath: "/app",
      assetPrefix: "https://cdn.example.com",
    };
    const resolved = await resolveNextConfig(config);
    expect(resolved.assetPrefix).toBe("https://cdn.example.com");
  });

  it("defaults assetPrefix to empty string when neither assetPrefix nor basePath are set", async () => {
    const config: NextConfig = {};
    const resolved = await resolveNextConfig(config);
    expect(resolved.assetPrefix).toBe("");
  });

  it("defaults assetPrefix to empty string when config is null", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.assetPrefix).toBe("");
  });

  it("strips trailing slash from assetPrefix regardless of position", async () => {
    const config: NextConfig = {
      assetPrefix: "https://cdn.example.com/subdir/",
    };
    const resolved = await resolveNextConfig(config);
    expect(resolved.assetPrefix).toBe("https://cdn.example.com/subdir");
  });

  it('treats assetPrefix "/" as empty and falls back to basePath inheritance', async () => {
    const config: NextConfig = {
      basePath: "/app",
      assetPrefix: "/",
    };
    const resolved = await resolveNextConfig(config);
    expect(resolved.basePath).toBe("/app");
    expect(resolved.assetPrefix).toBe("/app");
  });
});

describe("assetPrefix — basePath + assetPrefix combination", () => {
  it("explicit CDN assetPrefix is not overridden by basePath, with both fields asserted", async () => {
    const config: NextConfig = {
      basePath: "/app",
      assetPrefix: "https://cdn.example.com",
    };
    const resolved = await resolveNextConfig(config);
    expect(resolved.basePath).toBe("/app");
    expect(resolved.assetPrefix).toBe("https://cdn.example.com");
  });

  it("does not produce a double-prefix when basePath and CDN assetPrefix are combined", async () => {
    const config: NextConfig = {
      basePath: "/app",
      assetPrefix: "https://cdn.example.com",
    };
    const resolved = await resolveNextConfig(config);
    expect(resolved.assetPrefix).not.toBe("https://cdn.example.com/app");
    expect(resolved.assetPrefix).toBe("https://cdn.example.com");
  });

  it("assetPrefix inherits basePath when assetPrefix is explicitly empty, with both fields asserted", async () => {
    const config: NextConfig = { basePath: "/app", assetPrefix: "" };
    const resolved = await resolveNextConfig(config);
    expect(resolved.basePath).toBe("/app");
    expect(resolved.assetPrefix).toBe("/app");
  });
});
