function hasParamProperty<T extends Record<string, unknown>>(obj: T, prop: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

// Properties that cannot be shadowed by param names because they need to
// remain the true underlying value for Promises / React to work correctly.
//
// Next.js comments out `value` and `error` in reflect-utils.ts because they
// use `Promise.resolve(underlyingParams)` directly in production, so React
// mutations on the promise object are never shadowed. vinext uses a Proxy
// that intercepts sync reads through a separate `plain` object, which means
// a param named `value` or `error` would shadow React's `.status`/`.value`
// attachments that React adds to resolved promises for `use()` caching.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/utils/reflect-utils.ts
const WELL_KNOWN_PROPERTIES = [
  // Object prototype
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "toLocaleString",

  // Promise prototype
  "then",
  "catch",
  "finally",

  // React Promise extension (status is explicitly reserved by Next.js;
  // value/error are reserved here because our Proxy-based approach creates
  // a shadowing risk that native Promise does not have)
  "status",
  "value",
  "error",

  // React introspection
  "displayName",
  "_debugInfo",

  // Common tested properties
  "toJSON",
  "$$typeof",
  "__esModule",

  // Tested by flight when checking for iterables
  "@@iterator",
] as const;

// The type-level set of well-known properties is derived directly from the
// runtime array above, so they can never drift out of sync. These properties
// are omitted from the synchronous intersection because the Proxy returns
// Promise/React internals for them, not the param value. After awaiting, the
// resolved object contains the actual param values for all keys.
type WellKnownProperty = (typeof WELL_KNOWN_PROPERTIES)[number];

const wellKnownProperties = new Set<PropertyKey>(WELL_KNOWN_PROPERTIES);

function isWellKnownProperty(prop: PropertyKey): boolean {
  return wellKnownProperties.has(prop);
}

export type ThenableParams<T extends Record<string, unknown>> = Promise<T> &
  Omit<T, WellKnownProperty>;

export function makeThenableParams<T extends Record<string, unknown>>(obj: T): ThenableParams<T> {
  const plain = { ...obj };
  const promise = Promise.resolve(plain);

  // The Proxy implements both Promise and plain-object behaviour so that
  // `await params` and `params.id` both work. TypeScript's Proxy type
  // cannot express this intersection precisely — the cast is isolated to
  // the boundary so the handler above stays fully type-checked.
  return new Proxy(promise, {
    get(target, prop, receiver) {
      if (!isWellKnownProperty(prop) && hasParamProperty(plain, prop)) {
        return Reflect.get(plain, prop);
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (!isWellKnownProperty(prop) && hasParamProperty(plain, prop)) {
        return {
          configurable: true,
          enumerable: true,
          value: Reflect.get(plain, prop),
          writable: true,
        };
      }

      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    has(target, prop) {
      return (
        Reflect.has(target, prop) || (!isWellKnownProperty(prop) && hasParamProperty(plain, prop))
      );
    },
    ownKeys() {
      return Reflect.ownKeys(plain).filter((prop) => !isWellKnownProperty(prop));
    },
  }) as unknown as ThenableParams<T>;
}
