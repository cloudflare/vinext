// Ported from Next.js: packages/next/src/lib/is-error.ts
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/lib/is-error.ts

// Ported from Next.js: packages/next/src/shared/lib/is-plain-object.ts
function isPlainObject(value: unknown): boolean {
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf");
}

/** JSON.stringify that replaces circular references with "[Circular]". */
function safeStringifyLite(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === "object" && nested !== null) {
      if (seen.has(nested)) {
        return "[Circular]";
      }
      seen.add(nested);
    }
    return nested;
  });
}

function isError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && "name" in value && "message" in value;
}

/** Turn a thrown value into an Error, as Next.js does before reporting it. */
export function getProperError(error: unknown): Error {
  if (isError(error)) {
    return error;
  }

  if (process.env.NODE_ENV === "development") {
    // Provide a better error for `throw undefined` and `throw null`.
    if (typeof error === "undefined") {
      return new Error(
        "An undefined error was thrown, " +
          "see here for more info: https://nextjs.org/docs/messages/threw-undefined",
      );
    }

    if (error === null) {
      return new Error(
        "A null error was thrown, " +
          "see here for more info: https://nextjs.org/docs/messages/threw-undefined",
      );
    }
  }

  return new Error(isPlainObject(error) ? safeStringifyLite(error) : String(error));
}
