import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getVinextReact } from "../packages/vinext/src/client/index.js";

type VinextReactInstance = typeof import("react");

const VINEXT_CLIENT_REACT = Symbol.for("vinext.client.react");

function reactInstance(name: string): VinextReactInstance {
  return { version: name } as unknown as VinextReactInstance;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, VINEXT_CLIENT_REACT);
  vi.unstubAllGlobals();
});

describe("getVinextReact", () => {
  it("returns the first React instance registered in the browser", () => {
    vi.stubGlobal("window", globalThis);
    const hostReact = reactInstance("host");
    const remoteReact = reactInstance("remote");

    expect(getVinextReact(hostReact)).toBe(hostReact);
    expect(getVinextReact(remoteReact)).toBe(hostReact);
    expect(Reflect.get(globalThis, Symbol.for("vinext.client.react"))).toBe(hostReact);
  });

  it("preserves an existing registration across duplicate or HMR module evaluation", () => {
    vi.stubGlobal("window", globalThis);
    const hostReact = reactInstance("host");
    const hmrReact = reactInstance("hmr");
    Reflect.set(globalThis, Symbol.for("vinext.client.react"), hostReact);

    expect(getVinextReact(hmrReact)).toBe(hostReact);
    expect(Reflect.get(globalThis, VINEXT_CLIENT_REACT)).toBe(hostReact);
  });

  it("returns the caller's React instance without creating server global state", () => {
    vi.stubGlobal("window", undefined);
    const serverReact = reactInstance("react-server");

    expect(getVinextReact(serverReact)).toBe(serverReact);
    expect(Reflect.has(globalThis, VINEXT_CLIENT_REACT)).toBe(false);
  });
});
