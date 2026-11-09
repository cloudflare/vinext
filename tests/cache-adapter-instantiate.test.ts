/**
 * Unit tests for the shim the generated `virtual:vinext-cache-adapters` module
 * uses to turn a configured adapter module's default export into an adapter.
 * The end-to-end proof (a class adapter configured on a real fixture app) lives
 * in tests/app-router-dev-server.test.ts ("class-based cache.data adapter").
 */
import vm from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  instantiateCacheAdapter,
  isClassExport,
  isConstructor,
} from "../packages/vinext/src/shims/cache-adapter-instantiate.js";

const args = { env: { KV: "binding" }, options: { label: "x" } };

function dataMethods() {
  return {
    async get() {
      return null;
    },
    async set() {},
    async revalidateTag() {},
  };
}

class DataAdapter {
  readonly received: unknown;
  constructor(input: unknown) {
    this.received = input;
  }
  async get() {
    return null;
  }
  async set() {}
  async revalidateTag() {}
}

// TypeScript `target: ES5` output for a class with prototype methods.
function Es5Base(this: { received: unknown }, input: unknown) {
  this.received = input;
}
Object.assign(Es5Base.prototype, dataMethods());

const ignore = () => {};

async function expectNoUnhandledRejection(run: () => void) {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
}

describe("isConstructor", () => {
  it("classifies functions by [[Construct]] without invoking them or reading their properties", () => {
    let calls = 0;
    function plain() {
      calls++;
    }
    class Native {
      constructor() {
        calls++;
      }
    }
    const hostile = new Proxy(Native, {
      get() {
        throw new Error("prototype read");
      },
    });
    expect(isConstructor(plain)).toBe(true);
    expect(isConstructor(Native)).toBe(true);
    expect(isConstructor(Native.bind(null))).toBe(true);
    expect(isConstructor(new Proxy(Native, {}))).toBe(true);
    expect(isConstructor(hostile)).toBe(true);
    expect(isConstructor(() => {})).toBe(false);
    expect(isConstructor(async () => {})).toBe(false);
    expect(isConstructor(async function () {})).toBe(false);
    expect(isConstructor({ create(this: void) {} }.create)).toBe(false);
    expect(isConstructor({})).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("isClassExport", () => {
  it("recognises class syntax only", () => {
    class FieldsOnly {
      value = 1;
    }
    class Sub extends DataAdapter {}
    function Es5Class() {}
    Es5Class.prototype.get = function () {};
    function factory() {
      return {};
    }
    function* generator() {}
    const methods = { class(this: void) {} };
    expect(isClassExport(DataAdapter)).toBe(true);
    expect(isClassExport(FieldsOnly)).toBe(true);
    expect(isClassExport(Sub)).toBe(true);
    expect(isClassExport(class {})).toBe(true);
    expect(isClassExport(Es5Class)).toBe(false);
    expect(isClassExport(new Proxy(DataAdapter, {}))).toBe(false);
    expect(isClassExport(DataAdapter.bind(null))).toBe(false);
    expect(isClassExport(factory)).toBe(false);
    expect(isClassExport(factory.bind(null))).toBe(false);
    expect(isClassExport(() => ({}))).toBe(false);
    expect(isClassExport(generator)).toBe(false);
    expect(isClassExport(methods.class)).toBe(false);
  });

  it("leaves factories with unusual prototypes classified as factories", () => {
    const frozen = Object.freeze(function frozenFactory() {
      return {};
    });
    function decorated() {
      return {};
    }
    decorated.prototype.meta = "adapter";
    function inherited() {
      return {};
    }
    inherited.prototype = Object.create(Es5Base.prototype);
    expect(isClassExport(frozen)).toBe(false);
    expect(isClassExport(decorated)).toBe(false);
    expect(isClassExport(inherited)).toBe(false);
  });
});

describe("instantiateCacheAdapter", () => {
  it("calls an arrow factory once with { env, options }", () => {
    const seen: unknown[] = [];
    const adapter = dataMethods();
    const factory = (input: unknown) => {
      seen.push(input);
      return adapter;
    };
    expect(instantiateCacheAdapter(factory, args, "data")).toBe(adapter);
    expect(seen).toEqual([args]);
  });

  it("calls a method-shorthand factory (not a constructor)", () => {
    const adapter = dataMethods();
    const mod = {
      create(this: void, input: unknown) {
        expect(input).toBe(args);
        return adapter;
      },
    };
    expect(instantiateCacheAdapter(mod.create, args, "data")).toBe(adapter);
  });

  it("calls a `function` factory with plain-call semantics", () => {
    const seen: unknown[] = [];
    const adapter = dataMethods();
    function createAdapter(this: unknown, input: unknown) {
      seen.push({ input, receiver: this, newTarget: new.target });
      return adapter;
    }
    expect(instantiateCacheAdapter(createAdapter, args, "data")).toBe(adapter);
    expect(seen).toEqual([{ input: args, receiver: undefined, newTarget: undefined }]);
  });

  it("keeps the receiver of a bound `function` factory", () => {
    const owner = {
      adapter: dataMethods(),
      create(this: { adapter: ReturnType<typeof dataMethods> }) {
        return this.adapter;
      },
    };
    function factory(this: typeof owner) {
      return this.create();
    }
    expect(instantiateCacheAdapter(factory.bind(owner), args, "data")).toBe(owner.adapter);
  });

  it("constructs a native class with { env, options }", () => {
    const adapter = instantiateCacheAdapter<DataAdapter>(DataAdapter, args, "data");
    expect(adapter).toBeInstanceOf(DataAdapter);
    expect(adapter.received).toBe(args);
  });

  it("constructs a subclass and a class whose methods are instance fields", () => {
    class Sub extends DataAdapter {}
    expect(instantiateCacheAdapter(Sub, args, "data")).toBeInstanceOf(Sub);

    class FieldAdapter {
      get = async () => null;
      set = async () => {};
      revalidateTag = async () => {};
    }
    expect(instantiateCacheAdapter(FieldAdapter, args, "data")).toBeInstanceOf(FieldAdapter);
  });

  it("calls factories with unusual prototypes instead of constructing them", () => {
    const adapter = dataMethods();
    const frozen = Object.freeze(function frozenFactory() {
      if (new.target) throw new Error("factory was constructed");
      return adapter;
    });
    expect(instantiateCacheAdapter(frozen, args, "data")).toBe(adapter);

    function decorated() {
      if (new.target) throw new Error("factory was constructed");
      return adapter;
    }
    decorated.prototype.meta = "adapter";
    expect(instantiateCacheAdapter(decorated, args, "data")).toBe(adapter);
  });

  it("calls constructors that are not class syntax, surfacing the runtime's error", () => {
    function Es5Adapter(this: Record<string, unknown>, input: unknown) {
      Object.assign(this, { received: input });
    }
    Object.assign(Es5Adapter.prototype, dataMethods());
    expect(() => instantiateCacheAdapter(Es5Adapter, args, "data")).toThrow(TypeError);
    expect(() => instantiateCacheAdapter(DataAdapter.bind(null), args, "data")).toThrow(TypeError);
    expect(() => instantiateCacheAdapter(new Proxy(DataAdapter, {}), args, "data")).toThrow(
      TypeError,
    );
  });

  it("constructs them through the documented `(args) => new Adapter(args)` export", () => {
    // TypeScript `target: ES5` class with prototype methods, and a subclass of it.
    function Es5Sub(this: { received: unknown }, input: unknown) {
      Es5Base.call(this, input);
    }
    Object.setPrototypeOf(Es5Sub, Es5Base);
    Es5Sub.prototype = Object.create(Es5Base.prototype, {
      constructor: { value: Es5Sub, writable: true, configurable: true },
    });
    // An ES5 class whose methods are all instance fields.
    function FieldsAdapter(this: Record<string, unknown>, input: unknown) {
      Object.assign(this, dataMethods(), { received: input });
    }
    const Bound = DataAdapter.bind(null);
    const Proxied = new Proxy(DataAdapter, {
      get() {
        throw new Error("prototype read");
      },
      construct(target, argumentsList) {
        return new target(...(argumentsList as [unknown]));
      },
    });

    for (const [Adapter, instanceOf] of [
      [Es5Base, Es5Base],
      [Es5Sub, Es5Base],
      [FieldsAdapter, FieldsAdapter],
      [Bound, DataAdapter],
      [Proxied, DataAdapter],
    ] as const) {
      const Construct = Adapter as unknown as new (input: unknown) => { received: unknown };
      const adapter = instantiateCacheAdapter<{ received: unknown }>(
        (input: unknown) => new Construct(input),
        args,
        "data",
      );
      expect(adapter).toBeInstanceOf(instanceOf);
      expect(adapter.received).toBe(args);
    }
  });

  it("propagates an error thrown by the adapter unchanged", () => {
    const failure = new Error("missing binding MY_KV");
    expect(() =>
      instantiateCacheAdapter(
        () => {
          throw failure;
        },
        args,
        "data",
      ),
    ).toThrow(failure);
    class Throws {
      constructor() {
        throw failure;
      }
    }
    expect(() => instantiateCacheAdapter(Throws, args, "data")).toThrow(failure);
  });

  it("rejects non-function default exports with an actionable message", () => {
    expect(() => instantiateCacheAdapter(dataMethods(), args, "data")).toThrow(
      "cache.data adapter: the module's default export must be a factory function or a class that receives { env, options }, got an object. To use an adapter object directly, export a factory that returns it: `export default () => adapter`.",
    );
    expect(() => instantiateCacheAdapter(undefined, args, "cdn")).toThrow(
      "cache.cdn adapter: the module's default export must be a factory function or a class that receives { env, options }, got undefined. Check that the module has a default export.",
    );
    expect(() => instantiateCacheAdapter(null, args, "data")).toThrow(/got null\.$/);
    expect(() => instantiateCacheAdapter("kv", args, "data")).toThrow(/got a string\.$/);
  });

  it("rejects a factory that returns a Promise", () => {
    expect(() => instantiateCacheAdapter(async () => dataMethods(), args, "data")).toThrow(
      "cache.data adapter: the default export returned a Promise. Adapter factories must return the adapter synchronously; defer async setup to the adapter's methods.",
    );
    function promiseFactory() {
      return Promise.resolve(dataMethods());
    }
    expect(() => instantiateCacheAdapter(promiseFactory, args, "data")).toThrow(
      /returned a Promise/,
    );
  });

  it("does not leave a rejected Promise result unhandled", async () => {
    await expectNoUnhandledRejection(() => {
      expect(() =>
        instantiateCacheAdapter(
          () => Promise.reject(new Error("async setup failed")),
          args,
          "data",
        ),
      ).toThrow(/returned a Promise/);
    });
  });

  it("rejects a Promise subclass whose species lookup throws", () => {
    let armed = true;
    class HostilePromise<T> extends Promise<T> {
      static get [Symbol.species]() {
        if (armed) throw new Error("species lookup");
        return Promise;
      }
    }
    // Shaped like an adapter, so only the Promise check stands between it and
    // being returned as one.
    const result = Object.assign(
      HostilePromise.reject(new Error("async setup failed")),
      dataMethods(),
    );
    try {
      expect(() => instantiateCacheAdapter(() => result, args, "data")).toThrow(
        /returned a Promise/,
      );
    } finally {
      armed = false;
      result.catch(() => {});
    }
  });

  it("rejects and handles another realm's Promise", async () => {
    const foreign = vm.runInNewContext(
      `Promise.reject(new Error("async setup failed"))`,
    ) as Promise<unknown>;
    const result = Object.assign(foreign, dataMethods());
    expect(result instanceof Promise).toBe(false);
    await expectNoUnhandledRejection(() => {
      expect(() => instantiateCacheAdapter(() => result, args, "data")).toThrow(
        /returned a Promise/,
      );
    });
  });

  it("handles the derived promise a subclass's species constructor returns", async () => {
    function RejectingSpecies(executor: (resolve: () => void, reject: () => void) => void) {
      executor(ignore, ignore);
      return Promise.reject(new Error("derived"));
    }
    class DerivedRejects<T> extends Promise<T> {
      static get [Symbol.species]() {
        return RejectingSpecies as unknown as PromiseConstructor;
      }
    }
    const result = Object.assign(new DerivedRejects(ignore), dataMethods());
    await expectNoUnhandledRejection(() => {
      expect(() => instantiateCacheAdapter(() => result, args, "data")).toThrow(
        /returned a Promise/,
      );
    });
  });

  it("judges a Promise by its brand, not its Symbol.toStringTag", () => {
    const tagged = { ...dataMethods(), [Symbol.toStringTag]: "Promise" };
    expect(instantiateCacheAdapter(() => tagged, args, "data")).toBe(tagged);

    const masked = Object.defineProperty(
      Object.assign(Promise.resolve(), dataMethods()),
      Symbol.toStringTag,
      { value: "CacheHandler" },
    );
    expect(() => instantiateCacheAdapter(() => masked, args, "data")).toThrow(/returned a Promise/);
  });

  it("accepts a synchronous adapter that has its own then method", () => {
    // Adapter contracts do not reserve `then`, so these thenables are the point.
    const then = vi.fn(() => {
      throw new Error("then must not be invoked");
    });
    // oxlint-disable-next-line unicorn/no-thenable
    const adapter = { ...dataMethods(), then };
    expect(instantiateCacheAdapter(() => adapter, args, "data")).toBe(adapter);
    expect(then).not.toHaveBeenCalled();

    class ThenableAdapter extends DataAdapter {
      // oxlint-disable-next-line unicorn/no-thenable
      then() {
        throw new Error("then must not be invoked");
      }
    }
    expect(instantiateCacheAdapter(ThenableAdapter, args, "data")).toBeInstanceOf(ThenableAdapter);
  });

  it("rejects results that are not an adapter object", () => {
    expect(() => instantiateCacheAdapter(() => undefined, args, "data")).toThrow(
      "cache.data adapter: the default export must produce an adapter object, got undefined. A data cache adapter implements get, set and revalidateTag.",
    );
    // A `function` factory that forgets to return.
    function forgetsToReturn() {}
    expect(() => instantiateCacheAdapter(forgetsToReturn, args, "data")).toThrow(
      /must produce an adapter object, got undefined\./,
    );
    expect(() => instantiateCacheAdapter(() => 42, args, "data")).toThrow(
      /must produce an adapter object, got a number\./,
    );
    // A class returned instead of an instance fails member validation.
    expect(() => instantiateCacheAdapter(() => DataAdapter, args, "data")).toThrow(
      /is missing method get, method set, method revalidateTag\./,
    );
  });

  it("accepts a callable adapter that has the required members", () => {
    const handler = Object.assign(function handler() {}, dataMethods());
    expect(instantiateCacheAdapter(() => handler, args, "data")).toBe(handler);
  });

  it("names the members a data adapter is missing", () => {
    expect(() =>
      instantiateCacheAdapter(() => ({ async get() {}, set: "nope" }), args, "data"),
    ).toThrow(
      "cache.data adapter: the adapter produced by the default export is missing method set, method revalidateTag. A data cache adapter implements get, set and revalidateTag.",
    );
  });

  it("requires buildResponseHeaders and a boolean ownsBackgroundRevalidation on a CDN adapter", () => {
    expect(() => instantiateCacheAdapter(DataAdapter, args, "cdn")).toThrow(
      "cache.cdn adapter: the adapter produced by the default export is missing method buildResponseHeaders, boolean ownsBackgroundRevalidation. A CDN cache adapter implements get, set, revalidateTag and buildResponseHeaders, and sets ownsBackgroundRevalidation to a boolean.",
    );

    class WithoutOwnership extends DataAdapter {
      buildResponseHeaders() {
        return {};
      }
    }
    expect(() => instantiateCacheAdapter(WithoutOwnership, args, "cdn")).toThrow(
      /is missing boolean ownsBackgroundRevalidation\./,
    );

    class CdnAdapter extends WithoutOwnership {
      readonly ownsBackgroundRevalidation = false;
    }
    expect(instantiateCacheAdapter(CdnAdapter, args, "cdn")).toBeInstanceOf(CdnAdapter);

    class GetterOwnership extends WithoutOwnership {
      get ownsBackgroundRevalidation() {
        return true;
      }
    }
    expect(instantiateCacheAdapter(GetterOwnership, args, "cdn")).toBeInstanceOf(GetterOwnership);
  });
});
