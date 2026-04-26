/**
 * Embed an Error's `.cause` chain into its own `.message` and `.stack` so
 * single-pass formatters (Vite's "Internal server error: ${err.message}\n${err.stack}"
 * dev-server logger, anything that just prints message + stack) reveal the
 * underlying root cause instead of silently dropping it.
 *
 * Without this, a wrapper like `new Error("Failed query", { cause: pgError })`
 * shows up in the Vite dev console as just "Failed query" — the actual
 * ECONNREFUSED / role-missing / socket-error in `.cause` is lost.
 *
 * Intended for **dev-server use only**. Production loggers (Node's
 * `console.error` → `util.inspect`, workerd's runtime logger) already render
 * `.cause` natively, so calling this in prod would double-print the cause —
 * once in the synthesized message, once in util.inspect's `[cause]:` block.
 * Callers should gate on `process.env.NODE_ENV !== "production"` (Vite
 * build-time-replaces this, so the prod bundle gets a no-op).
 *
 * - Best-effort: never throws. Frozen / non-extensible errors are left untouched.
 * - Idempotent (repeat calls are no-ops via a non-enumerable module-private symbol).
 * - Cycle-safe and depth-capped (10) for pathological cause graphs.
 * - Cause stack frames are appended as `at` lines so stack-cleaning regexes
 *   like Vite's `/^\s*at/` filter preserve them.
 */
const FLATTENED_MARKER = Symbol("vinext.errorCausesFlattened");
const MAX_CAUSE_DEPTH = 10;

function stringifyNonError(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function flattenErrorCauses(err: unknown): void {
  if (!(err instanceof Error)) return;
  const marked = err as Error & { [FLATTENED_MARKER]?: true };
  if (marked[FLATTENED_MARKER]) return;
  // defineProperty throws on frozen errors; mutations below also throw.
  // Wrap each step so this function honours its "never throw" contract —
  // a thrown TypeError here would propagate from the caller's catch block
  // and replace the user's real error with our enrichment failure.
  try {
    Object.defineProperty(marked, FLATTENED_MARKER, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } catch {
    return;
  }

  const seen = new WeakSet<object>([err]);
  const causes: Array<{ message: string; stack?: string }> = [];
  let cur: unknown = (err as { cause?: unknown }).cause;
  let depth = 0;
  while (cur != null && depth < MAX_CAUSE_DEPTH) {
    if (typeof cur === "object") {
      if (seen.has(cur as object)) break;
      seen.add(cur as object);
    }
    if (cur instanceof Error) {
      causes.push({ message: cur.message, stack: cur.stack });
      cur = (cur as { cause?: unknown }).cause;
    } else {
      causes.push({ message: stringifyNonError(cur) });
      cur = null;
    }
    depth++;
  }
  if (causes.length === 0) return;

  const messageSuffix = causes.map((c) => `  [cause]: ${c.message}`).join("\n");
  try {
    err.message = `${err.message}\n${messageSuffix}`;
  } catch {
    // Frozen / non-writable .message — leave the rest untouched too,
    // since a partial write would be misleading.
    return;
  }

  if (typeof err.stack === "string") {
    let stackSuffix = "";
    for (const c of causes) {
      const headline = c.message.split("\n", 1)[0];
      stackSuffix += `\n    at [cause: ${headline}]`;
      if (c.stack) {
        const frames = c.stack
          .split("\n")
          .filter((l) => /^\s*at\s/.test(l))
          .join("\n");
        if (frames) stackSuffix += `\n${frames}`;
      }
    }
    try {
      err.stack = `${err.stack}${stackSuffix}`;
    } catch {
      // Stack is read-only on some hosts; message enrichment still holds.
    }
  }
}
