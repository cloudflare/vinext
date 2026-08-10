import { describe, expect, it } from "vite-plus/test";
import {
  createMountedSlotActiveRoutesHeader,
  normalizeMountedSlotActiveRoutesHeader,
  parseMountedSlotActiveRoutesHeader,
} from "../packages/vinext/src/server/app-mounted-slot-active-routes-header.js";

describe("mounted slot active route header", () => {
  it("serializes only active bindings in stable slot order", () => {
    expect(
      createMountedSlotActiveRoutesHeader([
        {
          activeRouteId: "route:/dashboard",
          ownerLayoutId: "layout:/dashboard",
          slotId: "slot:navbar:/dashboard",
          state: "active",
        },
        {
          ownerLayoutId: "layout:/dashboard",
          slotId: "slot:main:/dashboard",
          state: "default",
        },
        {
          activeRouteId: "route:/feed",
          ownerLayoutId: "layout:/",
          slotId: "slot:modal:/",
          state: "active",
        },
      ]),
    ).toBe("slot%3Amodal%3A%2F=route%3A%2Ffeed slot%3Anavbar%3A%2Fdashboard=route%3A%2Fdashboard");
  });

  it("normalizes duplicates and ignores malformed or non-route pairs", () => {
    const raw = [
      "broken",
      "slot%3Anavbar%3A%2Fdashboard=page%3A%2Fdashboard",
      "slot%3Anavbar%3A%2Fdashboard=route%3A%2Fold",
      "slot%3Anavbar%3A%2Fdashboard=route%3A%2Fdashboard",
    ].join(" ");

    expect(normalizeMountedSlotActiveRoutesHeader(raw)).toBe(
      "slot%3Anavbar%3A%2Fdashboard=route%3A%2Fdashboard",
    );
    expect(parseMountedSlotActiveRoutesHeader(raw)).toEqual(
      new Map([["slot:navbar:/dashboard", "route:/dashboard"]]),
    );
  });

  it("deterministically retains a bounded prefix when outbound pairs exceed the header limit", () => {
    const bindings = Array.from({ length: 20 }, (_, index) => ({
      activeRouteId: `route:/dashboard/${String(index).padStart(2, "0")}/${"r".repeat(180)}`,
      ownerLayoutId: "layout:/dashboard",
      slotId: `slot:slot-${String(index).padStart(2, "0")}:/dashboard/${"s".repeat(180)}`,
      state: "active" as const,
    }));

    const header = createMountedSlotActiveRoutesHeader(bindings);
    expect(header).not.toBeNull();
    expect(header!.length).toBeLessThanOrEqual(4096);
    expect(header!.split(" ").length).toBeGreaterThan(0);
    expect(header!.split(" ").length).toBeLessThan(bindings.length);
    expect(createMountedSlotActiveRoutesHeader([...bindings].reverse())).toBe(header);
  });
});
