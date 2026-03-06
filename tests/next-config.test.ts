import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadNextConfig } from "../packages/vinext/src/config/next-config.js";
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from "../packages/vinext/src/shims/constants.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-config-test-"));
}

describe("loadNextConfig phase argument", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes phase-production-build to function-form config when phase is specified", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default (phase) => ({ env: { RECEIVED_PHASE: phase } });\n`,
    );

    const config = await loadNextConfig(tmpDir, PHASE_PRODUCTION_BUILD);
    expect(config?.env?.RECEIVED_PHASE).toBe(PHASE_PRODUCTION_BUILD);
  });

  it("defaults to phase-development-server when no phase is provided", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default (phase) => ({ env: { RECEIVED_PHASE: phase } });\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.RECEIVED_PHASE).toBe(PHASE_DEVELOPMENT_SERVER);
  });

  it("ignores phase for object-form config", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default { env: { STATIC: "yes" } };\n`,
    );

    const config = await loadNextConfig(tmpDir, PHASE_PRODUCTION_BUILD);
    expect(config?.env?.STATIC).toBe("yes");
  });
});
