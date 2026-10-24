import { describe, expect, it, vi } from "vite-plus/test";
import { loadServerActionClientOrReload } from "../packages/vinext/src/server/app-browser-action-client-loader.js";

describe("loadServerActionClientOrReload", () => {
  it("returns the loaded module without reloading", async () => {
    const reload = vi.fn(() => true);
    const mod = { invokeClientServerAction: vi.fn() };
    await expect(loadServerActionClientOrReload(async () => mod as never, reload)).resolves.toBe(
      mod,
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads the document when the stale chunk fails to load", async () => {
    const reload = vi.fn(() => true);
    const load = async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    };
    const client = await loadServerActionClientOrReload(load, reload);
    await expect((client.invokeClientServerAction as () => Promise<unknown>)()).resolves.toBe(
      undefined,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("rethrows the load error when the reload is suppressed by the loop guard", async () => {
    const error = new TypeError("Failed to fetch dynamically imported module");
    const reload = vi.fn(() => false);
    await expect(
      loadServerActionClientOrReload(async () => Promise.reject(error), reload),
    ).rejects.toBe(error);
  });
});
