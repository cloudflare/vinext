import { describe, it, expect } from "vite-plus/test";
import { buildBarrelExportMap } from "../packages/vinext/src/plugins/optimize-imports.js";

let testId = 0;
function uniquePath(name: string): string {
  return `/fake/${name}-${++testId}/entry.js`;
}

describe("buildBarrelExportMap binding re-export cases", () => {
  it("handles import * as X; export { X }", async () => {
    const entryPath = uniquePath("import-ns-reexport");
    const barrelCode = `import * as AlertDialog from "@radix-ui/react-alert-dialog";\nexport { AlertDialog };`;
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );
    expect(map).not.toBeNull();
    expect(map!.get("AlertDialog")).toEqual({
      source: "@radix-ui/react-alert-dialog",
      isNamespace: true,
    });
  });

  it("handles import { X }; export { X }", async () => {
    const entryPath = uniquePath("import-named-reexport");
    const barrelCode = `import { format } from "date-fns/format";\nexport { format };`;
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );
    expect(map).not.toBeNull();
    expect(map!.get("format")).toEqual({
      source: "date-fns/format",
      isNamespace: false,
      originalName: "format",
    });
  });

  it("handles export { Local as Public } for same-file declarations", async () => {
    const entryPath = uniquePath("local-alias-reexport");
    const barrelCode = `const Mo = {};\nexport { Mo as Listbox };`;
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );
    expect(map).not.toBeNull();
    expect(map!.get("Listbox")).toEqual({
      source: entryPath,
      isNamespace: false,
      originalName: "Listbox",
    });
  });
});
