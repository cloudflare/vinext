import { describe, expect, it } from "vite-plus/test";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";

describe("makeThenableParams", () => {
  it("is awaitable even when params contain then", async () => {
    // eslint-disable-next-line unicorn/no-thenable
    const params = makeThenableParams({ then: "foo" });
    // If `then` were shadowing Promise.prototype.then, `await` would try to
    // treat the object as a thenable and call `then` with resolve/reject,
    // producing garbage or hanging. This must resolve to the plain object.
    const resolved = await params;
    // eslint-disable-next-line unicorn/no-thenable
    expect(resolved).toEqual({ then: "foo" });
  });

  it("allows sync access to non-well-known params", () => {
    // eslint-disable-next-line unicorn/no-thenable
    const params = makeThenableParams({ slug: "post", then: "foo" });
    expect(params.slug).toBe("post");
  });

  it("protects Promise methods from shadowing so the object stays thenable", () => {
    // eslint-disable-next-line unicorn/no-thenable
    const params = makeThenableParams({ then: "foo", catch: "bar", finally: "baz" });

    expect(typeof params.then).toBe("function");
    expect(typeof params.catch).toBe("function");
    expect(typeof params.finally).toBe("function");
  });

  it("protects React Promise status from shadowing", () => {
    const params = makeThenableParams({ status: "ok" });

    // React uses `status` on Promises for introspection; it must not be
    // shadowed by a param of the same name. Use Reflect.get because the
    // type system omits well-known properties from the sync intersection.
    expect(Reflect.get(params, "status")).not.toBe("ok");
  });

  it("protects React Promise value and error from shadowing", () => {
    const params = makeThenableParams({ value: "foo", error: "bar" });

    // React may mutate resolved promises to attach `.value` and `.error`
    // for `use()` caching. Our Proxy must not return the param value for
    // these keys, or React would read the wrong value on re-render.
    expect(Reflect.get(params, "value")).not.toBe("foo");
    expect(Reflect.get(params, "error")).not.toBe("bar");
  });

  it("excludes well-known properties from enumeration", () => {
    /* eslint-disable unicorn/no-thenable */
    const params = makeThenableParams({
      slug: "post",
      then: "foo",
      catch: "bar",
      finally: "baz",
      status: "ok",
      value: "val",
      error: "err",
      toString: "str",
    });
    /* eslint-enable unicorn/no-thenable */

    const keys = Object.keys(params);
    expect(keys).toEqual(["slug"]);
  });

  it("makes well-known param values available after awaiting", async () => {
    /* eslint-disable unicorn/no-thenable */
    const params = makeThenableParams({
      slug: "post",
      then: "foo",
      catch: "bar",
      finally: "baz",
      status: "ok",
      value: "val",
      error: "err",
    });
    /* eslint-enable unicorn/no-thenable */

    const resolved = await params;
    expect(resolved.slug).toBe("post");
    expect(resolved.then).toBe("foo");
    expect(resolved.catch).toBe("bar");
    expect(resolved.finally).toBe("baz");
    expect(resolved.status).toBe("ok");
    expect(resolved.value).toBe("val");
    expect(resolved.error).toBe("err");
  });

  it("preserves catch-all array params through sync and awaited access", async () => {
    const params = makeThenableParams({ slug: ["a", "b"] });

    expect(Reflect.get(params, "slug")).toEqual(["a", "b"]);
    expect(Object.keys(params)).toEqual(["slug"]);
    expect(await params).toEqual({ slug: ["a", "b"] });
  });

  it("preserves empty params through sync keys and awaiting", async () => {
    const params = makeThenableParams({});

    expect(Object.keys(params)).toEqual([]);
    expect(await params).toEqual({});
  });
});
