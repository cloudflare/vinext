import { afterEach, describe, expect, it } from "vite-plus/test";
import { devServerRegistry } from "../packages/vinext/src/plugins/react-server-dom-async-hook.js";

const originalLog = console.log;
const originalInfo = console.info;

afterEach(() => {
  const registry = devServerRegistry();
  registry.live.clear();
  registry.consoleLayers.length = 0;
  console.log = originalLog;
  console.info = originalInfo;
});

describe("dev server console layers", () => {
  // Each module replaces one console method, as React's Flight build and
  // vinext's hook warning suppression do.
  const calls: string[] = [];
  function evaluate(owner: object, kind: string, method: "log" | "info") {
    const registry = devServerRegistry();
    const layer = registry.scope.run(owner as never, () => registry.consoleLayer(kind));
    const replaced = console[method];
    const wrapper = (...args: unknown[]) => {
      calls.push(kind);
      replaced(...args);
    };
    console[method] = wrapper;
    layer?.record();
    return wrapper;
  }

  it("keeps a reloaded module's layers while another server's are above the old ones", () => {
    const registry = devServerRegistry();
    const a = { closed: false, hooks: new Map() };
    const b = { closed: false, hooks: new Map() };
    registry.live.add(a);
    registry.live.add(b);
    evaluate(a, "flight", "log");
    evaluate(a, "hook-warning", "info");
    evaluate(b, "flight", "log");
    const bInfo = evaluate(b, "hook-warning", "info");

    // A full reload of a: its old layers stay below b's, retired.
    const aLog = evaluate(a, "flight", "log");
    const aInfo = evaluate(a, "hook-warning", "info");

    expect(console.log).toBe(aLog);
    expect(console.info).toBe(aInfo);
    expect(console.info).not.toBe(bInfo);
    expect(registry.consoleLayers.filter((layer) => !layer.retired)).toHaveLength(4);
  });

  it("takes the layers of alternating reloads out of the chain", () => {
    const registry = devServerRegistry();
    const a = { closed: false, hooks: new Map() };
    const b = { closed: false, hooks: new Map() };
    registry.live.add(a);
    registry.live.add(b);
    console.log = () => {};
    for (let reload = 0; reload < 25; reload += 1) {
      for (const owner of [a, b]) {
        evaluate(owner, "flight", "log");
        evaluate(owner, "hook-warning", "log");
      }
    }

    expect(registry.consoleLayers).toHaveLength(4);
    calls.length = 0;
    console.log("message");
    expect(calls).toEqual(["hook-warning", "flight", "hook-warning", "flight"]);
  });
});
