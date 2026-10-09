import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import type { TracedPackages } from "../packages/vinext/src/build/nitro-trace-includes.js";

// On Windows, pathslash's toSlash converts `\` separators; on POSIX it is a
// no-op, so emulate the Windows behavior here.
vi.mock("pathslash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pathslash")>();
  return { ...actual, toSlash: (value: string) => value.replaceAll("\\", "/") };
});

describe("Nitro outputFileTracingIncludes on Windows", () => {
  it("reads backslash separators in include globs as `/`, like Next.js", async () => {
    const { createNitroTraceIncludes } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-windows-")),
    );
    try {
      const lib = path.join(root, "node_modules/typescript/lib");
      await fs.mkdir(lib, { recursive: true });
      await fs.writeFile(path.join(root, "node_modules/typescript/package.json"), "{}");
      await fs.writeFile(path.join(lib, "lib.es2020.d.ts"), "");
      const tracedPackages: TracedPackages = {};
      // test/e2e/twoslash builds this glob with path.relative().
      createNitroTraceIncludes({
        root,
        routes: ["/app"],
        includes: { "/": ["node_modules\\typescript\\lib\\lib.*.d.ts"] },
        excludes: {},
        warn: () => {},
      })!.tracedPackages(tracedPackages);
      expect(tracedPackages.typescript?.versions["0.0.0"]?.files).toEqual([
        path.join(lib, "lib.es2020.d.ts"),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
