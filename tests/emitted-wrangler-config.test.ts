import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { findEmittedWranglerConfig } from "../packages/vinext/src/utils/emitted-wrangler-config.js";

describe("findEmittedWranglerConfig", () => {
  it("finds dist/<worker>/wrangler.json", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-wrangler-"));
    fs.mkdirSync(path.join(cwd, "dist", "my-app"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "dist", "my-app", "wrangler.json"), "{}");
    expect(findEmittedWranglerConfig(cwd)).toBe(path.join(cwd, "dist", "my-app", "wrangler.json"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("prefers dist/server/wrangler.json", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-wrangler-"));
    fs.mkdirSync(path.join(cwd, "dist", "server"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "dist", "other"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "dist", "server", "wrangler.json"), "{}");
    fs.writeFileSync(path.join(cwd, "dist", "other", "wrangler.json"), "{}");
    expect(findEmittedWranglerConfig(cwd)).toBe(path.join(cwd, "dist", "server", "wrangler.json"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null without a Cloudflare build", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-wrangler-"));
    expect(findEmittedWranglerConfig(cwd)).toBeNull();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
