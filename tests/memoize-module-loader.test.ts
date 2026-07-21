import { describe, expect, it, vi } from "vite-plus/test";
import { memoizeModuleLoader } from "../packages/vinext/src/utils/memoize-module-loader.js";

describe("memoizeModuleLoader", () => {
  it("shares one in-flight load across concurrent callers", async () => {
    let resolveLoad!: (value: { value: number }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ value: number }>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const memoized = memoizeModuleLoader(load);

    const first = memoized();
    const second = memoized();
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);

    resolveLoad({ value: 42 });
    await expect(first).resolves.toEqual({ value: 42 });
    await expect(memoized()).resolves.toEqual({ value: 42 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries after a rejected load", async () => {
    const load = vi
      .fn<() => Promise<{ value: number }>>()
      .mockRejectedValueOnce(new Error("temporary module load failure"))
      .mockResolvedValueOnce({ value: 42 });
    const memoized = memoizeModuleLoader(load);

    await expect(memoized()).rejects.toThrow("temporary module load failure");
    await expect(memoized()).resolves.toEqual({ value: 42 });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
