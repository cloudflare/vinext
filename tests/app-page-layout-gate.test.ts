import { describe, expect, it } from "vite-plus/test";
import {
  createAppPageLayoutGate,
  getAppPageLayoutGate,
  registerAppPageLayoutGate,
} from "../packages/vinext/src/server/app-page-layout-gate.js";

const rendered = () => true;
const running = new Promise<never>(() => {});

describe("app page layout gate", () => {
  it("waits for every held layout, then reports the outermost that threw", async () => {
    const gate = createAppPageLayoutGate();
    gate.hold("layout:/", 0);
    gate.hold("layout:/a", 1);
    gate.hold("layout:/a/b", 2);
    let result: unknown = "pending";
    const waiting = gate.wait(rendered, running).then((value) => (result = value));

    gate.settle("layout:/a/b", { error: "inner" });
    gate.settle("layout:/a", { error: "outer" });
    await Promise.resolve();
    expect(result).toBe("pending");

    gate.settle("layout:/");
    await waiting;
    expect(result).toEqual({ error: "outer", layoutIndex: 1 });
  });

  it("reports the outermost held layout that has thrown so far without waiting", () => {
    const gate = createAppPageLayoutGate();
    gate.hold("layout:/", 0);
    gate.hold("layout:/a", 1);
    gate.hold("layout:/a/b", 2);
    expect(gate.failure()).toBeNull();
    gate.settle("layout:/");
    gate.settle("layout:/a/b", { error: "inner" });
    expect(gate.failure()).toEqual({ error: "inner", layoutIndex: 2 });
    gate.settle("layout:/a", { error: "outer" });
    expect(gate.failure()).toEqual({ error: "outer", layoutIndex: 1 });
  });

  it("resolves null once held layouts rendered", async () => {
    const gate = createAppPageLayoutGate();
    gate.hold("layout:/", 0);
    gate.settle("layout:/");
    gate.settle("layout:/", { error: "a retry doesn't count" });
    await expect(gate.wait(rendered, running)).resolves.toBeNull();
  });

  it("doesn't wait for a held layout the payload doesn't render", async () => {
    const gate = createAppPageLayoutGate();
    gate.hold("layout:/", 0);
    gate.hold("layout:/skipped", 1);
    gate.settle("layout:/");
    await expect(
      gate.wait((layoutId) => layoutId !== "layout:/skipped", running),
    ).resolves.toBeNull();
  });

  it("keeps waiting past other errors, and stops when the render ends", async () => {
    for (const end of ["completes", "fails"] as const) {
      const gate = createAppPageLayoutGate();
      gate.hold("layout:/", 0);
      gate.hold("layout:/a", 1);
      const layoutError = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
      let endRender!: () => void;
      const ended = new Promise<void>((resolve, reject) => {
        endRender = end === "completes" ? resolve : () => reject(new Error("fatal"));
      });
      let settled = false;
      const waiting = gate.wait(rendered, ended);
      void waiting.then(() => (settled = true));

      // Flight renders the other entries after an error, so it isn't an end.
      gate.settle("layout:/a", { error: layoutError });
      await Promise.resolve();
      expect(settled).toBe(false);

      endRender();
      await expect(waiting).resolves.toEqual({ error: layoutError, layoutIndex: 1 });
    }
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
