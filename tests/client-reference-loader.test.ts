import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ChunkLoad = (chunkId: string) => Promise<unknown>;
type Loader = typeof import("../packages/vinext/src/shims/internal/client-reference-loader.js");

type FakeLink = {
  rel: string;
  as?: string;
  crossOrigin?: string;
  href: string;
  attributes: Record<string, string>;
  listeners: Record<string, () => void>;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-client-reference-loader-"));
const BASE = "https://app.example/docs/";
let links: FakeLink[];
let nonce: string | undefined;
let preloadErrors: { payload: unknown; prevent: boolean }[];

function createLink(): FakeLink {
  return {
    rel: "",
    href: "",
    attributes: {},
    listeners: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  };
}

beforeEach(() => {
  links = [];
  nonce = undefined;
  preloadErrors = [];
  const window = new EventTarget();
  window.addEventListener("vite:preloadError", (event) => {
    const error = preloadErrors.at(-1);
    if (error) error.payload = (event as Event & { payload?: unknown }).payload;
    if (error?.prevent) event.preventDefault();
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", {
    baseURI: BASE,
    head: { appendChild: (link: FakeLink) => links.push(link) },
    createElement: createLink,
    getElementsByTagName: () => links,
    querySelector: () => (nonce ? { nonce } : null),
  });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { __webpack_chunk_load__?: ChunkLoad }).__webpack_chunk_load__;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function loadLoader(): Promise<{ loader: Loader; loadChunk: ChunkLoad }> {
  const loader = await import("../packages/vinext/src/shims/internal/client-reference-loader.js");
  const loadChunk = (globalThis as { __webpack_chunk_load__?: ChunkLoad }).__webpack_chunk_load__;
  if (!loadChunk) throw new Error("the loader did not install __webpack_chunk_load__");
  return { loader, loadChunk };
}

describe("App Router client reference loader", () => {
  // @vitejs/plugin-rsc/browser reads `clientReferences.default[id]` and calls it.
  it("resolves a reference its module chunk registered", async () => {
    const { loader } = await loadLoader();
    const exports = { Widget: "widget" };
    loader.registerClientReference("abc123", exports);
    await expect(loader.clientReferences["abc123"]!()).resolves.toBe(exports);
    await expect(loader.clientReferences["missing"]!()).rejects.toThrow(
      "client reference not found 'missing'",
    );
    expect(Reflect.get(loader.clientReferences, "then")).toBeUndefined();
  });

  it("imports a reference's module chunk", async () => {
    const { loadChunk } = await loadLoader();
    const file = path.join(dir, "module.mjs");
    fs.writeFileSync(file, "globalThis.__vinextTestModuleLoaded = true;\n");
    await loadChunk(`m${pathToFileURL(file).href}`);
    expect((globalThis as { __vinextTestModuleLoaded?: boolean }).__vinextTestModuleLoaded).toBe(
      true,
    );
    expect(links).toEqual([]);
  });

  it("modulepreloads the JS chunks a module chunk imports, as Vite does", async () => {
    const { loadChunk } = await loadLoader();
    nonce = "abc";
    await expect(loadChunk("p/_next/static/chunks/dep.js")).resolves.toBeUndefined();
    await loadChunk("p/_next/static/chunks/dep.js");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      rel: "modulepreload",
      as: "script",
      crossOrigin: "",
      href: "https://app.example/_next/static/chunks/dep.js",
      attributes: { nonce: "abc" },
    });
  });

  it("imports a module chunk once its stylesheets load", async () => {
    const { loadChunk } = await loadLoader();
    const file = path.join(dir, "styled.mjs");
    fs.writeFileSync(file, "globalThis.__vinextTestStyledLoaded = true;\n");
    const loaded = () =>
      (globalThis as { __vinextTestStyledLoaded?: boolean }).__vinextTestStyledLoaded === true;
    const load = loadChunk(`m${pathToFileURL(file).href}\n/_next/static/css/a.css`);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      rel: "stylesheet",
      crossOrigin: "",
      href: "https://app.example/_next/static/css/a.css",
    });
    // A module chunk sharing the stylesheet waits for the same load.
    const other = path.join(dir, "other.mjs");
    fs.writeFileSync(other, "globalThis.__vinextTestOtherLoaded = true;\n");
    const otherLoad = loadChunk(`m${pathToFileURL(other).href}\n/_next/static/css/a.css`);
    expect(links).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loaded()).toBe(false);
    expect(
      (globalThis as { __vinextTestOtherLoaded?: boolean }).__vinextTestOtherLoaded,
    ).toBeUndefined();
    links[0]!.listeners.load!();
    await Promise.all([load, otherLoad]);
    expect(loaded()).toBe(true);
  });

  it("skips a stylesheet the document already links", async () => {
    const { loadChunk } = await loadLoader();
    const linked = createLink();
    linked.rel = "stylesheet";
    linked.href = "https://app.example/_next/static/css/a.css";
    links.push(linked);
    const file = path.join(dir, "linked.mjs");
    fs.writeFileSync(file, "export {};\n");
    await loadChunk(`m${pathToFileURL(file).href}\n/_next/static/css/a.css`);
    expect(links).toEqual([linked]);
  });

  // React keeps a failed chunk's promise for the session, which would fail
  // every reference sharing the stylesheet. As in Next.js, the reference
  // renders without it.
  it("dispatches vite:preloadError when a stylesheet fails, and imports the chunk anyway", async () => {
    const { loadChunk } = await loadLoader();
    preloadErrors.push({ payload: undefined, prevent: false });
    const file = path.join(dir, "unstyled.mjs");
    fs.writeFileSync(file, "export const ok = true;\n");
    const failed = loadChunk(`m${pathToFileURL(file).href}\n/_next/static/css/a.css`);
    links[0]!.listeners.error!();
    await expect(failed).resolves.toMatchObject({ ok: true });
    expect(preloadErrors[0]!.payload).toEqual(
      new Error("Unable to preload CSS for /_next/static/css/a.css"),
    );
  });

  it("rejects a chunk of an unknown kind", async () => {
    const { loadChunk } = await loadLoader();
    await expect(loadChunk("x/_next/static/chunks/a.js")).rejects.toThrow(
      "[vinext] Unknown client reference chunk 'x/_next/static/chunks/a.js'",
    );
  });
});
