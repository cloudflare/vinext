import { describe, expect, it } from "vite-plus/test";
import {
  createAppPageLayoutGate,
  getAppPageLayoutGate,
  registerAppPageLayoutGate,
} from "../packages/vinext/src/server/app-page-layout-gate.js";

const rendered = () => true;

describe("app page layout gate", () => {
  it("waits for every held layout, then reports the outermost that threw", async () => {
    const gate = createAppPageLayoutGate();
    gate.hold("layout:/", 0);
    gate.hold("layout:/a", 1);
    gate.hold("layout:/a/b", 2);
    let result: unknown = "pending";
    const waiting = gate.wait(rendered).then((value) => (result = value));

    gate.settle("layout:/a/b", { error: "inner" });
    gate.settle("layout:/a", { error: "outer" });
    await Promise.resolve();
    expect(result).toBe("pending");

    gate.settle("layout:/");
    await waiting;
    expect(result).toEqual({ error: "outer", layoutIndex: 1 });
  });

  it("resolves null once held layouts rendered", async () => {
    const gate = createAppPageLayoutGate();
    gate.hold("layout:/", 0);
    gate.settle("layout:/");
    gate.settle("layout:/", { error: "a retry doesn't count" });
    await expect(gate.wait(rendered)).resolves.toBeNull();
  });

  it("doesn't wait for a held layout the payload doesn't render", async () => {
    const gate = createAppPageLayoutGate();
    gate.hold("layout:/", 0);
    gate.hold("layout:/skipped", 1);
    gate.settle("layout:/");
    await expect(gate.wait((layoutId) => layoutId !== "layout:/skipped")).resolves.toBeNull();
  });

  it("stops waiting only when the render throws an error that may end it", async () => {
    const gate = createAppPageLayoutGate();
    gate.hold("layout:/", 0);
    gate.hold("layout:/a", 1);
    const layoutError = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
    const waiting = gate.wait(rendered);

    gate.settle("layout:/a", { error: layoutError });
    gate.observeRenderError(layoutError);
    // The page renders before its layouts, and its signals don't end the render.
    gate.observeRenderError({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    gate.observeRenderError({ digest: "NEXT_REDIRECT;replace;/login;307;" });
    let settled = false;
    void waiting.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.observeRenderError(new Error("a fatal error"));
    await expect(waiting).resolves.toEqual({ error: layoutError, layoutIndex: 1 });
  });

  it("is found from the elements record it was registered with", () => {
    const gate = createAppPageLayoutGate();
    const elements = {};
    registerAppPageLayoutGate(elements, gate);
    expect(getAppPageLayoutGate(elements)).toBe(gate);
    expect(getAppPageLayoutGate({})).toBeNull();
    expect(getAppPageLayoutGate(null)).toBeNull();
  });
});
