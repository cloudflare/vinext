import { once } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import {
  FIXTURE_HOOK_TIMEOUT_MS,
  FIXTURE_STARTUP_TIMEOUT_MS,
  startFixtureDevServer,
  type FixtureDevServer,
} from "./fixture-dev-server.js";

describe("fixture dev server helper", () => {
  it("keeps Vitest hook timeout above the internal startup timeout", () => {
    expect(FIXTURE_HOOK_TIMEOUT_MS).toBeGreaterThan(FIXTURE_STARTUP_TIMEOUT_MS);
  });

  it("terminates the child process when startup readiness times out", async () => {
    let fixtureProcess: FixtureDevServer["process"] | undefined;

    await expect(
      startFixtureDevServer({
        name: "never-ready",
        root: process.cwd(),
        port: 49_999,
        command: {
          bin: process.execPath,
          args: [
            "-e",
            "console.log('server booted but never listened'); setInterval(() => {}, 1000);",
          ],
        },
        startupTimeoutMs: 100,
        readinessPollIntervalMs: 10,
        readyRequestTimeoutMs: 20,
        serverSettleDelayMs: 0,
        onSpawn: (proc) => {
          fixtureProcess = proc;
        },
      }),
    ).rejects.toThrow(/Fixture "never-ready" did not start within 100ms: .*never listened/s);

    expect(fixtureProcess).toBeDefined();
    if (fixtureProcess && fixtureProcess.exitCode == null && !fixtureProcess.killed) {
      await once(fixtureProcess, "exit");
    }

    expect(fixtureProcess?.signalCode ?? fixtureProcess?.exitCode).not.toBeNull();
  });
});
