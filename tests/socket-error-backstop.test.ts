import { describe, expect, it } from "vite-plus/test";
import {
  isSocketErrorBackstopInstalled,
  peerDisconnectCode,
} from "../packages/vinext/src/server/socket-error-backstop.js";

describe("peerDisconnectCode", () => {
  it("returns the matched code for peer-disconnect errors", () => {
    expect(peerDisconnectCode(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(
      "ECONNRESET",
    );
    expect(peerDisconnectCode(Object.assign(new Error("pipe"), { code: "EPIPE" }))).toBe("EPIPE");
    expect(peerDisconnectCode(Object.assign(new Error("aborted"), { code: "ECONNABORTED" }))).toBe(
      "ECONNABORTED",
    );
  });

  it("returns undefined for non-peer-disconnect errors", () => {
    expect(peerDisconnectCode(new Error("boom"))).toBeUndefined();
    expect(
      peerDisconnectCode(Object.assign(new Error("nope"), { code: "ENOENT" })),
    ).toBeUndefined();
    expect(
      peerDisconnectCode(Object.assign(new Error("ehost"), { code: "EHOSTUNREACH" })),
    ).toBeUndefined();
  });

  it("handles non-Error / null / primitive reasons without throwing", () => {
    // unhandledRejection can fire with arbitrary reason values.
    expect(peerDisconnectCode(null)).toBeUndefined();
    expect(peerDisconnectCode(undefined)).toBeUndefined();
    expect(peerDisconnectCode("ECONNRESET")).toBeUndefined();
    expect(peerDisconnectCode(42)).toBeUndefined();
    // Plain object with the right shape is accepted (Node sometimes
    // emits these from native stream errors).
    expect(peerDisconnectCode({ code: "ECONNRESET" })).toBe("ECONNRESET");
    expect(peerDisconnectCode({ code: "OTHER" })).toBeUndefined();
  });
});

describe("installSocketErrorBackstop", () => {
  it("skips installation in test runners", () => {
    // process.env.VITEST is "true" inside Vitest workers, so import-time
    // installation is short-circuited and the predicate stays false.
    expect(process.env.VITEST).toBe("true");
    expect(isSocketErrorBackstopInstalled()).toBe(false);
  });
});
