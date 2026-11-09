import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  isBenignAssetImportError,
  isCancelledRequestBodyEnqueueError,
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

describe("isCancelledRequestBodyEnqueueError", () => {
  function invalidStateError(message: string, frame: string) {
    const err = Object.assign(new TypeError(`Invalid state: ${message}`), {
      code: "ERR_INVALID_STATE",
    });
    err.stack = [
      `TypeError [ERR_INVALID_STATE]: Invalid state: ${message}`,
      "    at ReadableStreamDefaultController.enqueue (node:internal/webstreams/readablestream:1102:13)",
      frame,
      "    at IncomingMessage.emit (node:events:509:28)",
      "    at Readable.read (node:internal/streams/readable:784:10)",
      "    at flow (node:internal/streams/readable:1290:53)",
    ].join("\n");
    return err;
  }

  it("matches the Readable.toWeb() adapter enqueueing after cancel", () => {
    expect(
      isCancelledRequestBodyEnqueueError(
        invalidStateError(
          "Controller is already closed",
          "    at IncomingMessage.onData (node:internal/webstreams/adapters:513:16)",
        ),
      ),
    ).toBe(true);
  });

  it("does NOT absorb closed-controller errors from other call sites", () => {
    expect(
      isCancelledRequestBodyEnqueueError(
        invalidStateError(
          "Controller is already closed",
          "    at Object.onData (file:///app/server/stream.js:12:3)",
        ),
      ),
    ).toBe(false);
    expect(
      isCancelledRequestBodyEnqueueError(
        invalidStateError(
          "ReadableStream is locked",
          "    at IncomingMessage.onData (node:internal/webstreams/adapters:513:16)",
        ),
      ),
    ).toBe(false);
    expect(isCancelledRequestBodyEnqueueError(new Error("Controller is already closed"))).toBe(
      false,
    );
    expect(isCancelledRequestBodyEnqueueError(null)).toBe(false);
    expect(isCancelledRequestBodyEnqueueError("ERR_INVALID_STATE")).toBe(false);
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

describe("installSocketErrorBackstop listeners", () => {
  // Vitest workers skip installation, so exercise the real listeners in a
  // child process with the test-runner env vars cleared.
  const backstopUrl = pathToFileURL(
    path.resolve(import.meta.dirname, "../packages/vinext/src/server/socket-error-backstop.ts"),
  ).href;

  function runWithBackstop(install: string, env: Record<string, string> = {}) {
    const script = `
      import { installSocketErrorBackstop } from ${JSON.stringify(backstopUrl)};
      ${install}
      process.on("unhandledRejection", () => console.log("app handler saw rejection"));
      void Promise.reject(new Error("floating rejection"));
      setTimeout(() => { throw new Error("uncaught throw"); }, 10);
      setTimeout(() => console.log("still running"), 50);
    `;
    return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, VITEST: "", NODE_ENV: "production", ...env },
      timeout: 10_000,
    });
  }

  // Next.js's router server logs uncaught exceptions and unhandled rejections
  // and keeps serving (packages/next/src/server/lib/router-server.ts, `logError`).
  it("logs and keeps running on a production server, even when installed first without the opt-in", () => {
    // Mirrors index.ts installing at module load before startProdServer opts in.
    const result = runWithBackstop(
      "installSocketErrorBackstop(); installSocketErrorBackstop({ runningServer: true });",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("app handler saw rejection");
    expect(result.stdout).toContain("still running");
    expect(result.stderr).toContain("[vinext] unhandledRejection: Error: floating rejection");
    expect(result.stderr).toContain("[vinext] uncaughtException: Error: uncaught throw");
  });

  it("re-throws outside a running production server", () => {
    const result = runWithBackstop("installSocketErrorBackstop();");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Error: floating rejection");
    expect(result.stdout).not.toContain("app handler saw rejection");
    expect(result.stdout).not.toContain("still running");
  });

  it("re-throws during prerender even after a running server opted in", () => {
    const result = runWithBackstop("installSocketErrorBackstop({ runningServer: true });", {
      VINEXT_PRERENDER: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Error: floating rejection");
    expect(result.stdout).not.toContain("still running");
  });
});
