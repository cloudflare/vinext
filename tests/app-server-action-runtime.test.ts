import { describe, expect, it } from "vite-plus/test";
import { resolveAppServerActionRuntimeId } from "../packages/vinext/src/server/app-server-action-runtime.js";

describe("App server action runtime resolution", () => {
  it("maps canonical production references to the matched edge graph", () => {
    expect(
      resolveAppServerActionRuntimeId(
        "canonical-reference#reportRuntime",
        true,
        { "canonical-reference": "edge-reference" },
        false,
      ),
    ).toBe("edge-reference#reportRuntime");
  });

  it("qualifies development references while preserving loader query parameters", () => {
    expect(resolveAppServerActionRuntimeId("/app/actions.ts?loader=1#run", true, {}, true)).toBe(
      "/app/actions.ts?loader=1&__vinext_app_runtime=edge#run",
    );
  });

  it("keeps node and already-qualified edge references unchanged", () => {
    expect(resolveAppServerActionRuntimeId("node-reference#run", false, {}, false)).toBe(
      "node-reference#run",
    );
    expect(
      resolveAppServerActionRuntimeId(
        "/app/actions.ts?__vinext_app_runtime=edge#run",
        true,
        {},
        true,
      ),
    ).toBe("/app/actions.ts?__vinext_app_runtime=edge#run");
  });
});
