import { describe, expect, it } from "vite-plus/test";
import { createTransformCache } from "../packages/vinext/src/plugins/transform-cache.js";

describe("createTransformCache", () => {
  it("returns the cached result for a repeated id/source pair without recomputing", () => {
    const cache = createTransformCache<undefined, { code: string }>();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return { code: "out" };
    };

    const first = cache("/app/page.tsx", "in", undefined, compute);
    const second = cache("/app/page.tsx", "in", undefined, compute);

    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("recomputes and replaces the entry when the source changes for an id", () => {
    const cache = createTransformCache<undefined, string>();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return `result-${calls}`;
    };

    expect(cache("/app/page.tsx", "v1", undefined, compute)).toBe("result-1");
    expect(cache("/app/page.tsx", "v2", undefined, compute)).toBe("result-2");
    // The v1 entry was replaced, not retained alongside v2.
    expect(cache("/app/page.tsx", "v1", undefined, compute)).toBe("result-3");
  });

  it("caches variants independently for the same id/source pair", () => {
    const cache = createTransformCache<string, string>();
    let calls = 0;
    const compute = (variant: string) => () => {
      calls += 1;
      return `${variant}-${calls}`;
    };

    const server = cache("/app/page.tsx", "in", "server", compute("server"));
    const client = cache("/app/page.tsx", "in", "client", compute("client"));

    expect(server).toBe("server-1");
    expect(client).toBe("client-2");
    expect(cache("/app/page.tsx", "in", "server", compute("server"))).toBe(server);
    expect(cache("/app/page.tsx", "in", "client", compute("client"))).toBe(client);
    expect(calls).toBe(2);
  });

  it("caches null results instead of recomputing them", () => {
    const cache = createTransformCache<undefined, string | null>();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return null;
    };

    expect(cache("/app/page.tsx", "in", undefined, compute)).toBeNull();
    expect(cache("/app/page.tsx", "in", undefined, compute)).toBeNull();
    expect(calls).toBe(1);
  });

  it("keys entries by id so distinct modules with identical source do not collide", () => {
    const cache = createTransformCache<undefined, { id: string }>();

    const a = cache("/app/a.tsx", "same", undefined, () => ({ id: "a" }));
    const b = cache("/app/b.tsx", "same", undefined, () => ({ id: "b" }));

    expect(a).not.toBe(b);
    expect(cache("/app/a.tsx", "same", undefined, () => ({ id: "recomputed" }))).toBe(a);
  });
});
