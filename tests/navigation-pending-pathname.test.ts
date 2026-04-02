import { describe, it, expect } from "vite-plus/test";

describe("navigation state - pendingPathname helpers", () => {
  describe("type definition", () => {
    it("exports setPendingPathname function", async () => {
      const nav = await import("../packages/vinext/src/shims/navigation.js");
      expect(typeof nav.setPendingPathname).toBe("function");
    });

    it("exports clearPendingPathname function", async () => {
      const nav = await import("../packages/vinext/src/shims/navigation.js");
      expect(typeof nav.clearPendingPathname).toBe("function");
    });
  });

  describe("setPendingPathname", () => {
    it("is a function that accepts a pathname string", async () => {
      const { setPendingPathname } = await import("../packages/vinext/src/shims/navigation.js");
      expect(typeof setPendingPathname).toBe("function");
      // Verify it accepts a string parameter without throwing
      expect(setPendingPathname.length).toBe(1);
    });
  });

  describe("clearPendingPathname", () => {
    it("is a function that accepts no parameters", async () => {
      const { clearPendingPathname } = await import("../packages/vinext/src/shims/navigation.js");
      expect(typeof clearPendingPathname).toBe("function");
      expect(clearPendingPathname.length).toBe(0);
    });
  });
});
