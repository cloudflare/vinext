// Properties that cannot be shadowed by param names because they need to
// remain the true underlying value for Promises / React to work correctly.
// Shared by the server's `makeThenableParams` and the browser's client page
// `searchParams`, so this module must stay free of server-only imports.
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
export type WellKnownProperty = (typeof WELL_KNOWN_PROPERTIES)[number];

const wellKnownProperties = new Set<PropertyKey>(WELL_KNOWN_PROPERTIES);

export function isWellKnownProperty(prop: PropertyKey): boolean {
  return wellKnownProperties.has(prop);
}

/**
 * Methods that ask about the thenable's own properties. They must run on the
 * proxy, not the underlying promise, so they see the param keys.
 */
export function isOwnPropertyCheck(prop: PropertyKey): boolean {
  return prop === "hasOwnProperty" || prop === "propertyIsEnumerable";
}
