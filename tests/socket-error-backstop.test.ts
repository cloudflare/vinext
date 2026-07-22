import { describe, expect, it } from "vite-plus/test";
import {
  isBenignAssetImportError,
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

describe("isBenignAssetImportError", () => {
  // Regression coverage for the react-version deploy suite (issue #1510):
  // a floating `import(new URL("./style.css", import.meta.url).href)` in an
  // edge API route rejects at module-load time and must not crash the build
  // or the running server.

  it("matches ERR_UNKNOWN_FILE_EXTENSION for static assets present on disk", () => {
    // Shape Node throws when the asset resolves but is not an ES module.
    const err = Object.assign(
      new Error('Unknown file extension ".css" for /app/dist/server/ssr/style.css'),
      { code: "ERR_UNKNOWN_FILE_EXTENSION" },
    );
    expect(isBenignAssetImportError(err)).toBe(true);

    for (const ext of [".scss", ".png", ".svg", ".woff2", ".wasm", ".txt"]) {
      const e = Object.assign(new Error(`Unknown file extension "${ext}" for /x/y${ext}`), {
        code: "ERR_UNKNOWN_FILE_EXTENSION",
      });
      expect(isBenignAssetImportError(e), ext).toBe(true);
    }
  });

  it("matches ERR_MODULE_NOT_FOUND only when the missing URL is a static asset", () => {
    // Shape Node throws when the asset URL does not resolve (chunk lives in
    // dist/server/, the source asset is not co-located).
    const cssMissing = Object.assign(new Error("Cannot find module ..."), {
      code: "ERR_MODULE_NOT_FOUND",
      url: "file:///app/dist/server/ssr/style.css",
    });
    expect(isBenignAssetImportError(cssMissing)).toBe(true);

    const cssWithQuery = Object.assign(new Error("Cannot find module ..."), {
      code: "ERR_MODULE_NOT_FOUND",
      url: "file:///app/dist/server/ssr/style.css?v=123",
    });
    expect(isBenignAssetImportError(cssWithQuery)).toBe(true);
  });

  it("does NOT absorb missing JS/TS modules (real bugs must still crash)", () => {
    for (const url of [
      "file:///app/dist/server/missing.js",
      "file:///app/dist/server/missing.mjs",
      "file:///app/dist/server/missing.ts",
      "file:///app/dist/server/missing", // no extension (bare specifier)
    ]) {
      const err = Object.assign(new Error("Cannot find module ..."), {
        code: "ERR_MODULE_NOT_FOUND",
        url,
      });
      expect(isBenignAssetImportError(err), url).toBe(false);
    }

    // A bare package that can't be resolved has no usable `url` field.
    const bare = Object.assign(new Error("Cannot find package 'twoslash'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(isBenignAssetImportError(bare)).toBe(false);
  });

  it("does NOT absorb unrelated error codes or non-object reasons", () => {
    expect(isBenignAssetImportError(new Error("boom"))).toBe(false);
    expect(
      isBenignAssetImportError(Object.assign(new Error("nope"), { code: "ERR_REQUIRE_ESM" })),
    ).toBe(false);
    expect(isBenignAssetImportError(null)).toBe(false);
    expect(isBenignAssetImportError(undefined)).toBe(false);
    expect(isBenignAssetImportError("ERR_UNKNOWN_FILE_EXTENSION")).toBe(false);
    expect(isBenignAssetImportError(42)).toBe(false);
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
