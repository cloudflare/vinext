/**
 * POST /api/compatibility/classify
 *
 * Upserts the router-classification metadata for Next.js e2e test files.
 * One row per test file; primary-keyed on `suite` so subsequent submissions
 * (Next.js ref bump, override-file edit, heuristic improvement) overwrite
 * in place.
 *
 * Decoupled from /api/compatibility (the results-ingest endpoint) on
 * purpose: classifications conceptually describe test files, not runs.
 * Re-classifying does not require re-running tests, and a partial test run
 * (e.g. all shards failed) still gets a fresh classification snapshot.
 *
 * The /compatibility UI joins compat_file_results.suite to
 * compat_suite_meta.suite at query time; result rows without a matching
 * meta row render as "unknown".
 *
 * Auth: requires `X-Compat-Secret` header (same secret as the results
 * ingest endpoint).
 *
 * Body:
 *   {
 *     classifiedAt?: number,        // optional unix millis; defaults to now
 *     suites: Array<{
 *       suite: string,              // test file path
 *       router: "app" | "pages" | "both" | "unknown",
 *     }>,
 *   }
 *
 * Returns `{ ok: true, upserted: N }`.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/app/lib/db/client";
import { compatSuiteMeta, type RouterKind } from "@/app/lib/db/schema";
import { requireIngestAuth } from "../_auth";

type SubmitSuite = {
  suite: string;
  router: RouterKind;
};

type SubmitBody = {
  classifiedAt?: number;
  suites: SubmitSuite[];
};

/**
 * Upper bound on suites per submission. Today the Next.js e2e tree has
 * ~1000 test files; 5000 leaves headroom for future Next.js growth and
 * for batching multiple test trees (deploy + ecosystem + vitest) without
 * splitting the request.
 */
const MAX_SUITES = 5000;

const VALID_ROUTERS: ReadonlySet<RouterKind> = new Set(["app", "pages", "both", "unknown"]);

/**
 * Minimum acceptable `classifiedAt` value. Anything earlier almost certainly
 * indicates a unit mistake (seconds instead of milliseconds) or a buggy
 * caller sending `0`/`-1`. Set to 2023-01-01 UTC — comfortably in the past
 * for any legitimate ingest while still rejecting both common mistakes.
 *
 * Documented on the wire as "unix millis"; this is the runtime guard.
 */
const MIN_CLASSIFIED_AT_MS = Date.UTC(2023, 0, 1);

function isValidBody(body: unknown): body is SubmitBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.classifiedAt !== undefined) {
    if (typeof b.classifiedAt !== "number") return false;
    if (!Number.isFinite(b.classifiedAt)) return false;
    if (b.classifiedAt < MIN_CLASSIFIED_AT_MS) return false;
  }
  if (!Array.isArray(b.suites)) return false;
  if (b.suites.length === 0) return false;
  if (b.suites.length > MAX_SUITES) return false;
  for (const s of b.suites) {
    if (!s || typeof s !== "object") return false;
    const sr = s as Record<string, unknown>;
    if (typeof sr.suite !== "string" || sr.suite.length === 0) return false;
    if (typeof sr.router !== "string") return false;
    if (!VALID_ROUTERS.has(sr.router as RouterKind)) return false;
  }
  return true;
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireIngestAuth(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return Response.json({ error: "Invalid body shape" }, { status: 400 });
  }

  try {
    return await writeClassifications(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/compatibility/classify] write failed:", message);
    return Response.json(
      { error: "Failed to persist classifications", detail: message },
      { status: 500 },
    );
  }
}

async function writeClassifications(body: SubmitBody): Promise<Response> {
  const db = getDb();
  const classifiedAt = body.classifiedAt ?? Date.now();

  // De-duplicate by suite, keeping the LAST occurrence. If a caller
  // somehow sends two rows for the same suite in one batch (e.g. an
  // override merged with heuristic output where both kept the entry),
  // SQLite's UPSERT would let the second one win but the same statement
  // can't insert two rows with the same PK in one INSERT; we'd error.
  // Dedupe here so the upsert sees one row per suite.
  const bySuite = new Map<string, SubmitSuite>();
  for (const s of body.suites) bySuite.set(s.suite, s);
  const rows = Array.from(bySuite.values()).map((s) => ({
    suite: s.suite,
    router: s.router,
    classifiedAt,
  }));

  // D1 enforces SQLite's 100-variable cap per statement; each row binds
  // 3 columns (suite, router, classified_at), so up to 33 rows per INSERT.
  const COLUMNS_PER_ROW = 3;
  const MAX_VARS = 100;
  const CHUNK = Math.floor(MAX_VARS / COLUMNS_PER_ROW);

  // batch() is typed as a non-empty tuple; we know at least one chunk
  // exists (validator rejects empty arrays), so cast at the call site.
  const stmts: unknown[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    stmts.push(
      db
        .insert(compatSuiteMeta)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: compatSuiteMeta.suite,
          set: {
            router: sqlExcluded("router"),
            classifiedAt: sqlExcluded("classified_at"),
          },
        }),
    );
  }
  await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);

  return Response.json({ ok: true, upserted: rows.length });
}

/**
 * Columns of `compat_suite_meta` that we want to update on conflict.
 * The PK (`suite`) is intentionally excluded — by definition it can't
 * change on conflict, and including it here would let a refactor
 * accidentally feed it into `sqlExcluded` below.
 */
type ExcludedColumn = "router" | "classified_at";

/**
 * Helper to reference `excluded.<col>` inside an ON CONFLICT ... DO UPDATE
 * SET clause. SQLite's `excluded` pseudo-table holds the values that would
 * have been inserted, which is what we want for an upsert.
 *
 * Drizzle exposes this via `sql.raw`. Because `sql.raw` bypasses parameter
 * binding, we restrict `column` to a closed union of known schema columns
 * so the safety invariant ("no user input ever reaches `sql.raw`") is
 * compiler-enforced rather than relying on a comment.
 */
function sqlExcluded(column: ExcludedColumn) {
  return sql.raw(`excluded.${column}`);
}
