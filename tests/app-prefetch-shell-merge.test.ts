import { describe, expect, it } from "vite-plus/test";
import { AppElementsWire, type AppElements } from "../packages/vinext/src/server/app-elements.js";
import { mergeDynamicPrefetchWithShell } from "../packages/vinext/src/server/app-prefetch-shell-merge.js";

function metadata(layoutIds: readonly string[]): AppElements {
  return {
    ...AppElementsWire.createMetadataEntries({
      interceptionContext: null,
      layoutIds,
      rootLayoutTreePath: "/",
      routeId: "route:/dynamic",
    }),
    [AppElementsWire.keys.layoutFlags]: Object.fromEntries(layoutIds.map((id) => [id, "s"])),
  };
}

describe("dynamic prefetch shell merge", () => {
  it("fills skip-pruned layouts from the prerequisite shell", () => {
    const shell: AppElements = {
      ...metadata(["layout:/", "layout:/dynamic"]),
      "layout:/": "root shell layout",
    };
    const dynamic: AppElements = {
      ...metadata(["layout:/", "layout:/dynamic"]),
      "layout:/dynamic": "layout below the shell cutoff",
      "page:/dynamic": "dynamic page",
      [AppElementsWire.keys.skippedLayoutIds]: ["layout:/"],
    };

    const merged = mergeDynamicPrefetchWithShell(shell, dynamic);

    expect(merged["layout:/"]).toBe("root shell layout");
    expect(merged["layout:/dynamic"]).toBe("layout below the shell cutoff");
    expect(merged["page:/dynamic"]).toBe("dynamic page");
    expect(AppElementsWire.readMetadata(merged).skippedLayoutIds).toEqual([]);
  });

  it("keeps missing skipped layouts marked for mounted-state preservation", () => {
    const shell = metadata(["layout:/", "layout:/dynamic"]);
    const dynamic: AppElements = {
      ...metadata(["layout:/", "layout:/dynamic"]),
      "page:/dynamic": "dynamic page",
      [AppElementsWire.keys.skippedLayoutIds]: ["layout:/dynamic"],
    };

    const merged = mergeDynamicPrefetchWithShell(shell, dynamic);

    expect(Object.hasOwn(merged, "layout:/dynamic")).toBe(false);
    expect(AppElementsWire.readMetadata(merged).skippedLayoutIds).toEqual(["layout:/dynamic"]);
  });
});
