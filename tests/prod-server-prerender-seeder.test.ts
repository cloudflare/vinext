import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveAppRouterPrerenderSeeder } from "../packages/vinext/src/server/prod-server.js";

describe("resolveAppRouterPrerenderSeeder", () => {
  it("uses the seeder exported by the RSC entry module", async () => {
    const calls: string[] = [];
    const seedPrerenderedRoutes = resolveAppRouterPrerenderSeeder({
      seedMemoryCacheFromPrerender(serverDir: string): number {
        calls.push(serverDir);
        return 7;
      },
    });

    await expect(seedPrerenderedRoutes("/app/dist/server")).resolves.toBe(7);
    expect(calls).toEqual(["/app/dist/server"]);
  });

  it("falls back to the startup seeder for older app entries", async () => {
    const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prerender-seeder-"));
    try {
      const seedPrerenderedRoutes = resolveAppRouterPrerenderSeeder({});

      await expect(seedPrerenderedRoutes(serverDir)).resolves.toBe(0);
    } finally {
      fs.rmSync(serverDir, { recursive: true, force: true });
    }
  });
});
