import { describe, expect, it, vi } from "vite-plus/test";
import {
  ModuleDependencyStore,
  type ModuleDependencyEntry,
} from "../packages/vinext/src/build/module-dependency-cache.js";

type Entries = Record<string, Partial<ModuleDependencyEntry<string>>>;

function createCollector(entries: Entries) {
  return vi.fn(async (moduleId: string): Promise<ModuleDependencyEntry<string>> => ({
    dependencies: [],
    resolvedFiles: [],
    cacheable: true,
    ...entries[moduleId],
  }));
}

describe("ModuleDependencyStore", () => {
  it("keeps dependency lists across reads", async () => {
    const store = new ModuleDependencyStore<string>();
    const collect = createCollector({ "/app/a.ts": { dependencies: ["a.css"] } });

    expect(await store.read("/app/a.ts", collect)).toEqual(["a.css"]);
    expect(await store.read("/app/a.ts", collect)).toEqual(["a.css"]);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it.each(["create", "update"] as const)(
    "drops only the module whose file had a %s event",
    async (event) => {
      const store = new ModuleDependencyStore<string>();
      const collect = createCollector({
        "/app/a.ts": { resolvedFiles: ["/app/b.ts"] },
      });
      for (const id of ["/app/a.ts", "/app/b.ts", "/app/b.ts?worker_file", "/app/c.ts"]) {
        await store.read(id, collect);
      }
      collect.mockClear();

      store.invalidate(["/app/b.ts"], event);
      for (const id of ["/app/a.ts", "/app/b.ts", "/app/b.ts?worker_file", "/app/c.ts"]) {
        await store.read(id, collect);
      }

      expect(collect.mock.calls.map(([id]) => id)).toEqual(["/app/b.ts", "/app/b.ts?worker_file"]);
    },
  );

  it("drops modules whose imports resolved to a deleted file", async () => {
    const store = new ModuleDependencyStore<string>();
    const collect = createCollector({
      "/app/a.ts": { resolvedFiles: ["/app/style.css"] },
      "/app/b.ts": { resolvedFiles: ["/app/other.css"] },
    });
    await store.read("/app/a.ts", collect);
    await store.read("/app/b.ts", collect);
    collect.mockClear();

    store.invalidate(["/link/style.css", "/app/style.css"], "delete");
    await store.read("/app/a.ts", collect);
    await store.read("/app/b.ts", collect);

    expect(collect.mock.calls.map(([id]) => id)).toEqual(["/app/a.ts"]);
  });

  it("matches any spelling of the changed file", async () => {
    const store = new ModuleDependencyStore<string>();
    const collect = createCollector({});
    await store.read("/real/a.ts", collect);
    collect.mockClear();

    store.invalidate(["/link/a.ts", "/real/a.ts"], "update");
    await store.read("/real/a.ts", collect);

    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("reads modules with unresolved imports again on every read", async () => {
    const store = new ModuleDependencyStore<string>();
    const collect = createCollector({ "/app/a.ts": { cacheable: false } });

    await store.read("/app/a.ts", collect);
    await store.read("/app/a.ts", collect);

    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("does not keep a read that a file event overlapped", async () => {
    const store = new ModuleDependencyStore<string>();
    let finishRead!: () => void;
    const collect = vi.fn(async (): Promise<ModuleDependencyEntry<string>> => {
      await new Promise<void>((resolve) => (finishRead = resolve));
      return { dependencies: ["old.css"], resolvedFiles: [], cacheable: true };
    });

    const pending = store.read("/app/a.ts", collect);
    store.invalidate(["/app/a.ts"], "update");
    finishRead();
    expect(await pending).toEqual(["old.css"]);

    const fresh = createCollector({ "/app/a.ts": { dependencies: ["new.css"] } });
    expect(await store.read("/app/a.ts", fresh)).toEqual(["new.css"]);
  });

  it("keeps a read that only unrelated file events overlapped", async () => {
    const store = new ModuleDependencyStore<string>();
    let finishRead!: () => void;
    const collect = vi.fn(async (): Promise<ModuleDependencyEntry<string>> => {
      await new Promise<void>((resolve) => (finishRead = resolve));
      return { dependencies: ["a.css"], resolvedFiles: ["/app/a.css"], cacheable: true };
    });

    const pending = store.read("/app/a.ts", collect);
    store.invalidate(["/app/other.ts"], "update");
    store.invalidate(["/app/a.css"], "update");
    finishRead();
    await pending;
    const fresh = createCollector({});
    await store.read("/app/a.ts", fresh);

    expect(fresh).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the deletion of a resolved file",
      (store: ModuleDependencyStore<string>) => store.invalidate(["/app/a.css"], "delete"),
    ],
    ["clear", (store: ModuleDependencyStore<string>) => store.clear()],
  ])("does not keep a read that %s overlapped", async (_name, interrupt) => {
    const store = new ModuleDependencyStore<string>();
    let finishRead!: () => void;
    const collect = vi.fn(async (): Promise<ModuleDependencyEntry<string>> => {
      await new Promise<void>((resolve) => (finishRead = resolve));
      return { dependencies: ["a.css"], resolvedFiles: ["/app/a.css"], cacheable: true };
    });

    const pending = store.read("/app/a.ts", collect);
    interrupt(store);
    finishRead();
    await pending;
    const fresh = createCollector({});
    await store.read("/app/a.ts", fresh);

    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed read", async () => {
    const store = new ModuleDependencyStore<string>();
    const failing = vi.fn(async (): Promise<ModuleDependencyEntry<string>> => {
      throw new Error("resolve failed");
    });

    await expect(store.read("/app/a.ts", failing)).rejects.toThrow("resolve failed");
    const collect = createCollector({ "/app/a.ts": { dependencies: ["a.css"] } });
    expect(await store.read("/app/a.ts", collect)).toEqual(["a.css"]);
  });

  it("clear drops every module", async () => {
    const store = new ModuleDependencyStore<string>();
    const collect = createCollector({});
    await store.read("/app/a.ts", collect);
    collect.mockClear();

    store.clear();
    await store.read("/app/a.ts", collect);

    expect(collect).toHaveBeenCalledTimes(1);
  });
});
