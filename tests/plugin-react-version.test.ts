import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { resolvePluginReactPath } from "../packages/vinext/src/utils/plugin-react-version.js";

vi.mock("../packages/vinext/src/utils/plugin-react-version.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/vinext/src/utils/plugin-react-version.js")>();
  return { ...actual, resolvePluginReactPath: vi.fn(actual.resolvePluginReactPath) };
});

let roots: string[] = [];

function makeRoot(pluginReactVersion?: string): { root: string; entry: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-plugin-react-version-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
  const dir = path.join(root, "node_modules", "@vitejs", "plugin-react");
  const entry = path.join(dir, "dist", "index.js");
  if (pluginReactVersion) {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@vitejs/plugin-react",
        version: pluginReactVersion,
        main: "dist/index.js",
      }),
    );
    fs.writeFileSync(entry, "");
  }
  return { root, entry: fs.existsSync(entry) ? fs.realpathSync(entry) : entry };
}

// pnpm's bin shims (including the one running this test) put
// node_modules/.pnpm/node_modules on NODE_PATH, so every lookup would reach the
// repo's own plugin-react. Node reads NODE_PATH once at startup; re-run its
// path setup so each test controls it.
const originalNodePath = process.env.NODE_PATH;
function setNodePath(value: string | undefined): void {
  if (value === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = value;
  (Module as unknown as { _initPaths(): void })._initPaths();
}

beforeEach(() => setNodePath(undefined));

afterEach(() => {
  setNodePath(originalNodePath);
  vi.restoreAllMocks();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("resolvePluginReactPath", () => {
  it("prefers a supported project copy", () => {
    const project = makeRoot("6.1.0");
    const fallback = makeRoot("6.0.1");

    expect(
      fs.realpathSync(resolvePluginReactPath(project.root, path.join(fallback.root, "index.js"))!),
    ).toBe(project.entry);
  });

  it("falls back to vinext's copy when the project resolves an unsupported version", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const project = makeRoot("4.7.0");
    const fallback = makeRoot("6.0.1");

    expect(
      fs.realpathSync(resolvePluginReactPath(project.root, path.join(fallback.root, "index.js"))!),
    ).toBe(fallback.entry);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[vinext] Ignoring @vitejs/plugin-react 4.7.0"),
    );
  });

  it("ignores an unsupported copy that the project only reaches through NODE_PATH", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hoisted = makeRoot("4.7.0");
    setNodePath(path.join(hoisted.root, "node_modules"));
    const project = makeRoot();
    const fallback = makeRoot("6.0.1");

    expect(
      fs.realpathSync(resolvePluginReactPath(project.root, path.join(fallback.root, "index.js"))!),
    ).toBe(fallback.entry);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[vinext] Ignoring @vitejs/plugin-react 4.7.0"),
    );
  });

  it("falls back to vinext's copy without a warning when the project has none", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const project = makeRoot();
    const fallback = makeRoot("5.1.4");

    expect(
      fs.realpathSync(resolvePluginReactPath(project.root, path.join(fallback.root, "index.js"))!),
    ).toBe(fallback.entry);
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws when every copy found is unsupported", () => {
    const project = makeRoot("4.7.0");
    const fallback = makeRoot();

    expect(() =>
      resolvePluginReactPath(project.root, path.join(fallback.root, "index.js")),
    ).toThrow("vinext: @vitejs/plugin-react 5.1.4 or newer is required (found 4.7.0 at ");
  });

  it("returns null when plugin-react is not installed", () => {
    const project = makeRoot();
    const fallback = makeRoot();

    expect(resolvePluginReactPath(project.root, path.join(fallback.root, "index.js"))).toBeNull();
  });

  it("is not called when vinext's React plugin is disabled", () => {
    vi.mocked(resolvePluginReactPath).mockClear();

    void vinext({ react: false, rsc: false });

    expect(resolvePluginReactPath).not.toHaveBeenCalled();
  });
});
