/**
 * Native Node modules are stubbed only for Cloudflare. Node and Nitro servers
 * load them natively, so they must keep resolving to the real packages. The
 * Cloudflare behavior itself is covered end to end by
 * tests/cloudflare-native-module-stubs.test.ts.
 */
import type { EnvironmentOptions } from "vite";
import { describe, expect, it } from "vite-plus/test";
import { createCloudflareNativeModuleStubsPlugin } from "../packages/vinext/src/plugins/cloudflare-native-module-stubs.js";

function setUp(isCloudflare: boolean) {
  const plugin = createCloudflareNativeModuleStubsPlugin(() => isCloudflare);
  const resolveId = plugin.resolveId as { handler: () => string | undefined };
  const configEnvironment = plugin.configEnvironment as (
    name: string,
    config: EnvironmentOptions,
  ) => void;
  const config: EnvironmentOptions = {};
  configEnvironment("rsc", config);
  return { resolved: resolveId.handler(), config };
}

describe("vinext:cloudflare-native-module-stubs", () => {
  it("stubs native modules for Cloudflare", () => {
    const { resolved, config } = setUp(true);
    expect(resolved).toBeTypeOf("string");
    expect(config.optimizeDeps?.rolldownOptions?.plugins).toHaveLength(1);
  });

  it("leaves native modules alone without Cloudflare", () => {
    const { resolved, config } = setUp(false);
    expect(resolved).toBeUndefined();
    expect(config.optimizeDeps).toBeUndefined();
  });
});
