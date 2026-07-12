import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolvePrerenderPoolSize,
  startPrerenderServerPool,
} from "../packages/vinext/src/build/prerender-server-pool.js";

describe("prerender server pool sizing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMachine(cores: number, totalmem: number): void {
    vi.spyOn(os, "availableParallelism").mockReturnValue(cores);
    vi.spyOn(os, "totalmem").mockReturnValue(totalmem);
  }

  it("keeps small prerenders in the in-process server", () => {
    mockMachine(16, 64 * 1024 * 1024 * 1024);

    expect(resolvePrerenderPoolSize(47)).toBe(1);
  });

  it("caps by routes, cores, memory, and the explicit worker override", () => {
    mockMachine(16, 64 * 1024 * 1024 * 1024);

    expect(resolvePrerenderPoolSize(96, 2)).toBe(2);
    expect(resolvePrerenderPoolSize(384)).toBe(8);

    mockMachine(4, 64 * 1024 * 1024 * 1024);
    expect(resolvePrerenderPoolSize(384)).toBe(3);

    mockMachine(16, 2 * 1024 * 1024 * 1024);
    expect(resolvePrerenderPoolSize(384)).toBe(1);

    mockMachine(16, 2.5 * 1024 * 1024 * 1024);
    expect(resolvePrerenderPoolSize(384)).toBe(2);
  });

  it("treats an explicit concurrency of 1 as opting out of the process pool", () => {
    mockMachine(16, 64 * 1024 * 1024 * 1024);

    expect(resolvePrerenderPoolSize(384, 1)).toBe(1);
  });

  function writeWorkerEntry(source: string): { dir: string; entry: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prerender-pool-worker-"));
    const entry = path.join(dir, "worker.js");
    fs.writeFileSync(entry, source, "utf-8");
    return { dir, entry };
  }

  it("starts and closes stub render workers", async () => {
    const { dir, entry } = writeWorkerEntry(`
      process.send({ type: "ready", port: 30000 + (process.pid % 10000) });
      setInterval(() => {}, 1000);
    `);

    try {
      const pool = await startPrerenderServerPool(dir, 2, entry);
      try {
        expect(pool.ports).toHaveLength(2);
        expect(pool.ports.every((port) => typeof port === "number")).toBe(true);
        expect(() => pool.assertHealthy()).not.toThrow();
      } finally {
        await pool.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails assertHealthy immediately after a worker transport error", async () => {
    const { dir, entry } = writeWorkerEntry(`
      process.send({ type: "ready", port: 4124 });
      setInterval(() => {}, 1000);
    `);

    try {
      const pool = await startPrerenderServerPool(dir, 1, entry);
      try {
        pool.recordRenderError(new Error("renderPage returned 500"));
        expect(() => pool.assertHealthy()).not.toThrow();

        const transportError = Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
        pool.recordRenderError(transportError);
        expect(() => pool.assertHealthy()).toThrow(/request failed \(ECONNRESET\)/);
      } finally {
        await pool.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails assertHealthy when a ready worker exits unexpectedly", async () => {
    const { dir, entry } = writeWorkerEntry(`
      process.send({ type: "ready", port: 4123 });
      setTimeout(() => process.exit(42), 25);
    `);

    try {
      const pool = await startPrerenderServerPool(dir, 1, entry);
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(() => pool.assertHealthy()).toThrow(/exited unexpectedly .*code 42/);
      } finally {
        await pool.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects when a worker exits before reporting ready", async () => {
    const { dir, entry } = writeWorkerEntry("process.exit(0);");

    try {
      await expect(startPrerenderServerPool(dir, 1, entry)).rejects.toThrow(
        "exited during startup (code 0, signal null)",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
