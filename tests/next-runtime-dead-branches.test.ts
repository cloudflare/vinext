import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import {
  blankDeadNextRuntimeRequireBranches,
  definedNextRuntime,
} from "../packages/vinext/src/plugins/next-runtime-dead-branches.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const INSTRUMENTATION = `export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    globalThis.runtime = "edge";
  } else if (process.env.NEXT_RUNTIME === "nodejs") {
    globalThis.runtime = "nodejs";
  } else {
    await require("this should fail");
  }
}
`;

describe("blankDeadNextRuntimeRequireBranches", () => {
  it("blanks a require() in a branch the define makes dead, keeping offsets", () => {
    const out = blankDeadNextRuntimeRequireBranches(
      INSTRUMENTATION,
      "/app/instrumentation.js",
      "nodejs",
    );
    expect(out).toBeDefined();
    expect(out).not.toContain("this should fail");
    expect(out).toHaveLength(INSTRUMENTATION.length);
    expect(out!.split("\n")).toHaveLength(INSTRUMENTATION.split("\n").length);
    // The live branches are untouched.
    expect(out).toContain(`globalThis.runtime = "nodejs";`);
    expect(out).toContain(`globalThis.runtime = "edge";`);
  });

  it("keeps the edge-only require when the define says edge", () => {
    const code = `if (process.env.NEXT_RUNTIME !== "edge") { require("node-only"); } else { require("edge-only"); }\n`;
    const out = blankDeadNextRuntimeRequireBranches(code, "/app/a.js", "edge");
    expect(out).not.toContain("node-only");
    expect(out).toContain(`require("edge-only")`);
  });

  it("handles ?:, !, && and || tests", () => {
    const code = [
      `const a = process.env.NEXT_RUNTIME === "edge" ? require("edge-a") : 1;`,
      `if (!(process.env.NEXT_RUNTIME === "nodejs")) require("not-node");`,
      `if (process.env.NEXT_RUNTIME === "edge" && check()) { require("edge-and"); }`,
      `if (process.env.NEXT_RUNTIME === "nodejs" || check()) { live(); } else { require("never"); }`,
    ].join("\n");
    const out = blankDeadNextRuntimeRequireBranches(code, "/app/a.js", "nodejs")!;
    for (const gone of ["edge-a", "not-node", "edge-and", "never"]) {
      expect(out).not.toContain(gone);
    }
    expect(out).toContain("live()");
    expect(out).toContain("check()");
  });

  it("leaves code alone when the test is unknown, process is shadowed, or nothing is defined", () => {
    const unknown = `if (process.env.NEXT_RUNTIME === flag) { require("x"); }\n`;
    expect(blankDeadNextRuntimeRequireBranches(unknown, "/app/a.js", "nodejs")).toBeUndefined();
    const shadowed = `const process = { env: {} };\nif (process.env.NEXT_RUNTIME === "edge") { require("x"); }\n`;
    expect(blankDeadNextRuntimeRequireBranches(shadowed, "/app/a.js", "nodejs")).toBeUndefined();
    expect(
      blankDeadNextRuntimeRequireBranches(INSTRUMENTATION, "/app/a.js", undefined),
    ).toBeUndefined();
    const noRequire = `if (process.env.NEXT_RUNTIME === "edge") { edge(); }\n`;
    expect(blankDeadNextRuntimeRequireBranches(noRequire, "/app/a.js", "nodejs")).toBeUndefined();
  });

  it("keeps a dead branch that declares a hoisted var or function binding", () => {
    // Blanking would delete the binding the live code still reads:
    // `export default impl || "node"` must stay "node", not a ReferenceError.
    const withVar = `if (process.env.NEXT_RUNTIME === "edge") { var impl = require("./edge"); }\nexport default impl || "node";\n`;
    expect(blankDeadNextRuntimeRequireBranches(withVar, "/app/a.js", "nodejs")).toBeUndefined();
    const withFunction = `if (process.env.NEXT_RUNTIME === "edge") { function load() { return require("./edge"); } }\nexport default typeof load;\n`;
    expect(
      blankDeadNextRuntimeRequireBranches(withFunction, "/app/a.js", "nodejs"),
    ).toBeUndefined();
    // A var scoped to a nested function does not escape the branch, so the
    // branch is still blanked.
    const nestedVar = `if (process.env.NEXT_RUNTIME === "edge") { (() => { var x = require("./edge"); })(); }\n`;
    expect(blankDeadNextRuntimeRequireBranches(nestedVar, "/app/a.js", "nodejs")).not.toContain(
      "./edge",
    );
  });
  it("reads the runtime from an environment define map", () => {
    expect(definedNextRuntime({ "process.env.NEXT_RUNTIME": '"nodejs"' })).toBe("nodejs");
    expect(definedNextRuntime({ "process.env.NEXT_RUNTIME": '""' })).toBe("");
    expect(definedNextRuntime({})).toBeUndefined();
    expect(definedNextRuntime(undefined)).toBeUndefined();
  });
});

describe("vinext build: require() in a branch NEXT_RUNTIME makes dead", () => {
  it("does not resolve the dead require (Next.js instrumentation-hook parity)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vinext-next-runtime-dead-require-"));
    tempDirs.push(root);
    symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "next-runtime-dead-require", private: true, type: "module" }),
    );
    writeFileSync(path.join(root, "instrumentation.js"), INSTRUMENTATION);
    mkdirSync(path.join(root, "pages"));
    writeFileSync(
      path.join(root, "pages", "index.tsx"),
      `export default function Page() {\n  return <p>{String((globalThis as any).runtime)}</p>;\n}\n\nexport async function getServerSideProps() {\n  return { props: {} };\n}\n`,
    );

    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const outDir = path.join(root, "dist");
    const output = readdirSync(outDir, { recursive: true })
      .map(String)
      .filter((file) => /\.m?js$/.test(file))
      .map((file) => readFileSync(path.join(outDir, file), "utf8"))
      .join("\n");
    // The build resolved (it used to fail on "this should fail") and kept the live branch.
    expect(output).toMatch(/runtime\s*=\s*["`]nodejs["`]/);
    expect(output).not.toContain("this should fail");
  }, 120_000);
});
