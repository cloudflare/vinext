import { describe, expect, it } from "vite-plus/test";
import { resolveAppPageDevRequestTiming } from "../packages/vinext/src/server/request-log.js";

describe("app page dev request timing", () => {
  it("derives compile time from the Node-observed total and Worker render duration", () => {
    expect(resolveAppPageDevRequestTiming(3100, "2900")).toEqual({
      compileMs: 200,
      renderMs: 2900,
    });
  });

  it("omits the timing split when the Worker did not measure render duration", () => {
    expect(resolveAppPageDevRequestTiming(100, "-1")).toEqual({});
  });

  it("omits invalid timing values instead of logging impossible durations", () => {
    expect(resolveAppPageDevRequestTiming(100, "not-a-number")).toEqual({});
    expect(resolveAppPageDevRequestTiming(100, "1000000000000")).toEqual({});
  });
});
