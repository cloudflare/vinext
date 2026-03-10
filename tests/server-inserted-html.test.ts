import { describe, it, expect, beforeEach } from "vitest";

describe("useServerInsertedHTML", () => {
  beforeEach(async () => {
    // Clear any stale callbacks between tests
    const { clearServerInsertedHTML } = await import("../packages/vinext/src/shims/navigation.js");
    clearServerInsertedHTML();
  });

  it("is exported from next/navigation shim", async () => {
    const mod = await import("../packages/vinext/src/shims/navigation.js");
    expect(typeof mod.useServerInsertedHTML).toBe("function");
  });

  it("flushServerInsertedHTML is exported", async () => {
    const mod = await import("../packages/vinext/src/shims/navigation.js");
    expect(typeof mod.flushServerInsertedHTML).toBe("function");
  });

  it("clearServerInsertedHTML is exported", async () => {
    const mod = await import("../packages/vinext/src/shims/navigation.js");
    expect(typeof mod.clearServerInsertedHTML).toBe("function");
  });

  it("collects callbacks registered during SSR (no document)", async () => {
    const { useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    // In test environment, document is undefined (SSR-like)
    const results: string[] = [];
    useServerInsertedHTML(() => {
      results.push("called");
      return "<style>.a { color: red; }</style>";
    });

    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toBe("<style>.a { color: red; }</style>");
    expect(results).toEqual(["called"]);
  });

  it("collects multiple callbacks", async () => {
    const { useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    useServerInsertedHTML(() => "<style>.a {}</style>");
    useServerInsertedHTML(() => "<style>.b {}</style>");
    useServerInsertedHTML(() => "<style>.c {}</style>");

    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(3);
    expect(flushed[0]).toBe("<style>.a {}</style>");
    expect(flushed[1]).toBe("<style>.b {}</style>");
    expect(flushed[2]).toBe("<style>.c {}</style>");
  });

  it("flush clears the callback list", async () => {
    const { useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    useServerInsertedHTML(() => "first");

    const first = flushServerInsertedHTML();
    expect(first).toHaveLength(1);

    // Second flush should be empty
    const second = flushServerInsertedHTML();
    expect(second).toHaveLength(0);
  });

  it("clearServerInsertedHTML discards callbacks without calling them", async () => {
    const { useServerInsertedHTML, clearServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    let called = false;
    useServerInsertedHTML(() => {
      called = true;
      return "should not appear";
    });

    clearServerInsertedHTML();

    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(0);
    expect(called).toBe(false);
  });

  it("ignores null/undefined returns from callbacks", async () => {
    const { useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    useServerInsertedHTML(() => null);
    useServerInsertedHTML(() => undefined);
    useServerInsertedHTML(() => "<style>.valid {}</style>");

    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toBe("<style>.valid {}</style>");
  });

  it("handles callback errors gracefully", async () => {
    const { useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    useServerInsertedHTML(() => {
      throw new Error("CSS extraction failed");
    });
    useServerInsertedHTML(() => "<style>.ok {}</style>");

    // Should not throw, should skip the erroring callback
    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toBe("<style>.ok {}</style>");
  });

  it("callbacks can return React-like elements", async () => {
    const { useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    // Simulate a React element (like styled-components would return)
    const fakeElement = {
      $$typeof: Symbol.for("react.element"),
      type: "style",
      props: { children: ".x{}" },
    };
    useServerInsertedHTML(() => fakeElement);

    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toBe(fakeElement);
  });

  it("supports the styled-components SSR pattern", async () => {
    const { useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    // Simulate styled-components ServerStyleSheet pattern
    const collectedStyles: string[] = [];
    let extractCount = 0;

    // This simulates what a StyleRegistry component does
    useServerInsertedHTML(() => {
      extractCount++;
      collectedStyles.push(
        `<style data-styled="sc-${extractCount}">.sc-${extractCount} { color: red; }</style>`,
      );
      return collectedStyles[collectedStyles.length - 1];
    });

    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toContain("data-styled");
    expect(extractCount).toBe(1);
  });
});
