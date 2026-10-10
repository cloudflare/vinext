import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { init } from "../packages/vinext/src/init.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

let tmpDir: string;

function successfulChild(): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  queueMicrotask(() => child.emit("close", 0, null));
  return child;
}

describe("init command execution", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-init-exec-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-project", version: "1.0.0" }),
      "utf-8",
    );
    fs.mkdirSync(path.join(tmpDir, "pages"));
    fs.writeFileSync(
      path.join(tmpDir, "pages", "index.tsx"),
      "export default function Home() { return <div>hi</div> }",
      "utf-8",
    );
    spawnMock.mockReset();
    spawnMock.mockImplementation(successfulChild);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inherits stdio for dependency installs so package managers retain terminal capabilities", async () => {
    await init({
      root: tmpDir,
      skipCheck: true,
      platform: "node",
    });

    expect(spawnMock).toHaveBeenCalled();
    for (const [, options] of spawnMock.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          stdio: "inherit",
        }),
      );
    }
  });
});
