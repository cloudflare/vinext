import { EventEmitter } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { createNitroDevDepsOptimizerGatePlugin } from "../packages/vinext/src/plugins/nitro-dev-deps-optimizer-gate.js";

function createGate(isNitro: boolean, listening = false) {
  const plugin = createNitroDevDepsOptimizerGatePlugin(() => isNitro);
  const httpServer = Object.assign(new EventEmitter(), { listening });
  const configureServer = plugin.configureServer as (server: ViteDevServer) => void;
  configureServer({ httpServer } as unknown as ViteDevServer);
  const transform = plugin.transform as () => Promise<null> | undefined;
  return { httpServer, plugin, transform };
}

describe("vinext:nitro-dev-deps-optimizer-gate", () => {
  it("holds transforms until the dev server listens", async () => {
    const { httpServer, transform } = createGate(true);

    let settled = false;
    const pending = transform();
    expect(pending).toBeInstanceOf(Promise);
    void pending!.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    httpServer.emit("listening");
    await expect(pending).resolves.toBeNull();
    expect(transform()).toBeUndefined();
  });

  it("does not hold transforms once the server already listens", () => {
    const { transform } = createGate(true, true);
    expect(transform()).toBeUndefined();
  });

  it("only applies to Nitro server environments", () => {
    const nitro = createGate(true).plugin;
    const plain = createGate(false);
    const applyToEnvironment = nitro.applyToEnvironment as (environment: unknown) => boolean;
    expect(applyToEnvironment({ config: { consumer: "server" } })).toBe(true);
    expect(applyToEnvironment({ config: { consumer: "client" } })).toBe(false);
    expect(
      (plain.plugin.applyToEnvironment as (environment: unknown) => boolean)({
        config: { consumer: "server" },
      }),
    ).toBe(false);
    expect(plain.transform()).toBeUndefined();
  });
});
