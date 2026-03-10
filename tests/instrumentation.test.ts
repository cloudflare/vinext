import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findInstrumentationFile } from "../packages/vinext/src/server/instrumentation.js";

// The runInstrumentation/reportRequestError describe blocks re-import via
// vi.resetModules() to get fresh module-level state (_onRequestError).
// findInstrumentationFile is a pure function — no reset needed.

describe("findInstrumentationFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-instr-"));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the path when a file exists at root", () => {
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), "");

    const result = findInstrumentationFile(tmpDir);

    expect(result).toBe(path.join(tmpDir, "instrumentation.ts"));
  });

  it("prefers root over src/ directory (priority order)", () => {
    // Create both root and src/ variants
    fs.writeFileSync(path.join(tmpDir, "instrumentation.ts"), "");
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "");

    const result = findInstrumentationFile(tmpDir);

    // Root files come first in INSTRUMENTATION_FILES, so root wins
    expect(result).toBe(path.join(tmpDir, "instrumentation.ts"));
  });

  it("falls back to src/ directory", () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "instrumentation.ts"), "");

    const result = findInstrumentationFile(tmpDir);

    expect(result).toBe(path.join(tmpDir, "src", "instrumentation.ts"));
  });

  it("returns null when no instrumentation file exists", () => {
    const result = findInstrumentationFile(tmpDir);

    expect(result).toBeNull();
  });
});

describe("runInstrumentation", () => {
  let runInstrumentation: typeof import("../packages/vinext/src/server/instrumentation.js").runInstrumentation;
  let getOnRequestErrorHandler: typeof import("../packages/vinext/src/server/instrumentation.js").getOnRequestErrorHandler;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../packages/vinext/src/server/instrumentation.js");
    runInstrumentation = mod.runInstrumentation;
    getOnRequestErrorHandler = mod.getOnRequestErrorHandler;
  });

  afterEach(() => {
    delete globalThis.__VINEXT_onRequestErrorHandler__;
  });

  it("calls register() when exported", async () => {
    const register = vi.fn();
    const runner = {
      import: vi.fn().mockResolvedValue({ register }),
    };

    await runInstrumentation(runner, "/fake/instrumentation.ts");

    expect(register).toHaveBeenCalledOnce();
  });

  it("stores onRequestError handler for later retrieval", async () => {
    const onRequestError = vi.fn();
    const runner = {
      import: vi.fn().mockResolvedValue({ onRequestError }),
    };

    await runInstrumentation(runner, "/fake/instrumentation.ts");

    expect(getOnRequestErrorHandler()).toBe(onRequestError);
  });

  it("handles modules with no register or onRequestError gracefully", async () => {
    const runner = {
      import: vi.fn().mockResolvedValue({}),
    };

    // Should not throw
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    expect(getOnRequestErrorHandler()).toBeNull();
  });

  it("logs error and continues when import fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = {
      import: vi.fn().mockRejectedValue(new Error("Module not found")),
    };

    // Should not throw
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    expect(consoleSpy).toHaveBeenCalledWith(
      "[vinext] Failed to load instrumentation:",
      "Module not found",
    );
    consoleSpy.mockRestore();
  });
});

describe("reportRequestError", () => {
  let runInstrumentation: typeof import("../packages/vinext/src/server/instrumentation.js").runInstrumentation;
  let reportRequestError: typeof import("../packages/vinext/src/server/instrumentation.js").reportRequestError;

  const sampleRequest = { path: "/test", method: "GET", headers: {} };
  const sampleContext = {
    routerKind: "App Router" as const,
    routePath: "/test",
    routeType: "render" as const,
  };

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../packages/vinext/src/server/instrumentation.js");
    runInstrumentation = mod.runInstrumentation;
    reportRequestError = mod.reportRequestError;
  });

  it("calls the registered handler with correct args", async () => {
    const onRequestError = vi.fn();
    const runner = {
      import: vi.fn().mockResolvedValue({ onRequestError }),
    };
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    const error = new Error("boom");
    await reportRequestError(error, sampleRequest, sampleContext);

    expect(onRequestError).toHaveBeenCalledWith(error, sampleRequest, sampleContext);
  });

  it("no-ops when no handler is registered", async () => {
    // No runInstrumentation called, so _onRequestError is null.
    // Should not throw.
    await reportRequestError(new Error("boom"), sampleRequest, sampleContext);
  });

  it("catches and logs errors thrown by the handler", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onRequestError = vi.fn().mockRejectedValue(new Error("handler broke"));
    const runner = {
      import: vi.fn().mockResolvedValue({ onRequestError }),
    };
    await runInstrumentation(runner, "/fake/instrumentation.ts");

    await reportRequestError(new Error("boom"), sampleRequest, sampleContext);

    expect(consoleSpy).toHaveBeenCalledWith(
      "[vinext] onRequestError handler threw:",
      "handler broke",
    );
    consoleSpy.mockRestore();
  });
});
