/**
 * Resolve the Pages Router `api.bodyParser` config from a route module export.
 *
 * Next.js API routes can opt out of automatic body parsing or raise the
 * default 1 MB size limit:
 *
 *   export const config = { api: { bodyParser: false } };
 *   export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };
 *
 * `bodyParser: false` is critical for webhook handlers (Stripe, GitHub,
 * Slack, etc.) that must read the raw request bytes to verify an HMAC
 * signature. Silently parsing the body would consume the stream and break
 * signature verification — usually failing closed, sometimes failing open.
 *
 * @see https://nextjs.org/docs/pages/building-your-application/routing/api-routes#custom-config
 * @see Next.js: packages/next/src/server/api-utils/node/api-resolver.ts
 *
 * The format of `sizeLimit` mirrors what Next.js accepts via the `bytes`
 * package: a number of bytes, or a string with a unit suffix
 * (`"500b"`, `"100kb"`, `"4mb"`, `"1gb"`).
 */

/**
 * Default Pages Router API body size limit, matching Next.js.
 */
export const DEFAULT_PAGES_API_BODY_SIZE_LIMIT = 1 * 1024 * 1024;

/**
 * Resolved bodyParser configuration. When `enabled` is `false`, the body
 * MUST be passed through to the handler as a raw stream (or left unparsed
 * with `req.body === undefined`), so user code can read it itself.
 */
type ResolvedBodyParserConfig = { enabled: false } | { enabled: true; sizeLimit: number };

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
};

/**
 * Parse a Next.js-style `sizeLimit` string (e.g. `"4mb"`, `"100kb"`, `"1gb"`)
 * or numeric byte value into a number of bytes. Returns `undefined` for
 * inputs that can't be parsed — callers should fall back to the default.
 *
 * Matches the format accepted by Next.js (the `bytes` package); we
 * implement it inline to avoid pulling a dependency for a tiny parser.
 */
export function parseSizeLimit(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;

  // Match `<number><unit?>` where number can be int/decimal and unit is one
  // of b/kb/mb/gb/tb. The unit is optional — a bare number is bytes.
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/.exec(trimmed);
  if (!match) return undefined;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;

  const unit = match[2] ?? "b";
  const multiplier = SIZE_UNITS[unit];
  if (multiplier === undefined) return undefined;

  return Math.floor(amount * multiplier);
}

/**
 * Read the resolved `bodyParser` config from a route module's `config`
 * export. Defaults to enabled with the 1 MB Next.js default.
 */
export function resolveBodyParserConfig(
  moduleConfig: { api?: { bodyParser?: boolean | { sizeLimit?: string | number } } } | undefined,
  defaultSizeLimit: number = DEFAULT_PAGES_API_BODY_SIZE_LIMIT,
): ResolvedBodyParserConfig {
  const bodyParser = moduleConfig?.api?.bodyParser;

  // Explicit opt-out: leave the body untouched so handlers can read raw bytes.
  if (bodyParser === false) {
    return { enabled: false };
  }

  // `true` or `undefined` → default behaviour.
  if (bodyParser === undefined || bodyParser === true) {
    return { enabled: true, sizeLimit: defaultSizeLimit };
  }

  // Object form: honour `sizeLimit` if present and parseable, else default.
  if (typeof bodyParser === "object" && bodyParser !== null) {
    const parsed = parseSizeLimit(bodyParser.sizeLimit);
    return { enabled: true, sizeLimit: parsed ?? defaultSizeLimit };
  }

  // Anything else (truthy non-object/non-true) — be conservative and use
  // the default, matching Next.js's `!== false` check.
  return { enabled: true, sizeLimit: defaultSizeLimit };
}
