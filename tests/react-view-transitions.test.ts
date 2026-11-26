import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { reactExportsViewTransitions } from "../packages/vinext/src/utils/react-version.js";

let roots: string[] = [];

function makeRoot(reactSource?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-react-vt-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
  if (reactSource !== undefined) {
    const dir = path.join(root, "node_modules", "react");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "react", main: "index.js" }),
    );
    fs.writeFileSync(path.join(dir, "index.js"), reactSource);
  }
  return root;
}

// pnpm's bin shims put node_modules/.pnpm/node_modules on NODE_PATH, so a
// lookup from a temp root would reach the repo's own React.
const originalNodePath = process.env.NODE_PATH;
function setNodePath(value: string | undefined): void {
  if (value === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = value;
  (Module as unknown as { _initPaths(): void })._initPaths();
}

beforeEach(() => setNodePath(undefined));

afterEach(() => {
  setNodePath(originalNodePath);
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("reactExportsViewTransitions", () => {
  it("is true for a React that exports ViewTransition and addTransitionType", () => {
    const root = makeRoot(
      "exports.ViewTransition = Symbol.for('react.view_transition'); exports.addTransitionType = function () {};",
    );
    expect(reactExportsViewTransitions(root)).toBe(true);
  });

  it("is false for a React that predates them", () => {
    expect(reactExportsViewTransitions(makeRoot("exports.Suspense = 1;"))).toBe(false);
  });

  it("is false when React cannot be resolved", () => {
    expect(reactExportsViewTransitions(makeRoot())).toBe(false);
  });
});
