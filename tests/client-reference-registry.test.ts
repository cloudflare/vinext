import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";
import { CLIENT_REFERENCE_REGISTRY_GLOBAL } from "../packages/vinext/src/client/browser-globals.js";
import { LAZY_CLIENT_REFERENCES_MODULE } from "../packages/vinext/src/plugins/rsc-client-reference-loaders.js";

type Registry = Record<string, () => Promise<unknown>>;
type RegistryGlobal = Record<string, unknown>;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-client-reference-registry-"));
let moduleCount = 0;

/** A fresh instance of the client build's client-references module. */
async function loadClientReferences(): Promise<Registry> {
  const file = path.join(dir, `client-references-${moduleCount++}.mjs`);
  fs.writeFileSync(file, LAZY_CLIENT_REFERENCES_MODULE);
  return (await import(pathToFileURL(file).href)).default;
}

function registryUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

const REGISTRY = registryUrl(
  'export default { "abc123": async () => ({ get Widget() { return "widget"; } }) };',
);

afterEach(() => {
  delete (globalThis as RegistryGlobal)[CLIENT_REFERENCE_REGISTRY_GLOBAL];
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// @vitejs/plugin-rsc/browser reads `clientReferences.default[id]` and calls it.
describe("App Router client build client-references module", () => {
  it("loads a reference from the registry chunk the document names", async () => {
    const clientReferences = await loadClientReferences();
    (globalThis as RegistryGlobal)[CLIENT_REFERENCE_REGISTRY_GLOBAL] = REGISTRY;
    const exports = (await clientReferences["abc123"]!()) as { Widget: string };
    expect(exports.Widget).toBe("widget");
  });

  it("rejects a reference the registry does not have", async () => {
    const clientReferences = await loadClientReferences();
    (globalThis as RegistryGlobal)[CLIENT_REFERENCE_REGISTRY_GLOBAL] = REGISTRY;
    await expect(clientReferences["missing"]!()).rejects.toThrow(
      "client reference not found 'missing'",
    );
  });

  it("rejects when the document does not name the registry chunk", async () => {
    const clientReferences = await loadClientReferences();
    await expect(clientReferences["abc123"]!()).rejects.toThrow(
      "naming the client reference registry chunk did not run",
    );
  });

  it("ignores an inherited global", async () => {
    const clientReferences = await loadClientReferences();
    const prototype = Object.prototype as RegistryGlobal;
    prototype[CLIENT_REFERENCE_REGISTRY_GLOBAL] = REGISTRY;
    try {
      await expect(clientReferences["abc123"]!()).rejects.toThrow(
        "naming the client reference registry chunk did not run",
      );
    } finally {
      delete prototype[CLIENT_REFERENCE_REGISTRY_GLOBAL];
    }
  });

  it("imports the registry again after its import fails", async () => {
    const clientReferences = await loadClientReferences();
    (globalThis as RegistryGlobal)[CLIENT_REFERENCE_REGISTRY_GLOBAL] = registryUrl(
      'throw new Error("registry chunk failed");',
    );
    await expect(clientReferences["abc123"]!()).rejects.toThrow("registry chunk failed");
    (globalThis as RegistryGlobal)[CLIENT_REFERENCE_REGISTRY_GLOBAL] = REGISTRY;
    const exports = (await clientReferences["abc123"]!()) as { Widget: string };
    expect(exports.Widget).toBe("widget");
  });

  it("is not a thenable", async () => {
    const clientReferences = await loadClientReferences();
    expect((clientReferences as { then?: unknown }).then).toBeUndefined();
  });

  it("imports the registry once", async () => {
    const clientReferences = await loadClientReferences();
    let reads = 0;
    const url = registryUrl('export default { "a": async () => ({}), "b": async () => ({}) };');
    // Count reads of the global: the same URL would evaluate once anyway.
    Object.defineProperty(globalThis, CLIENT_REFERENCE_REGISTRY_GLOBAL, {
      configurable: true,
      get() {
        reads++;
        return url;
      },
    });
    await Promise.all([clientReferences["a"]!(), clientReferences["b"]!()]);
    await clientReferences["a"]!();
    expect(reads).toBe(1);
  });
});
