/**
 * POST /api/compatibility
 *
 * Ingests a compatibility test run. Called from the Next.js deploy-suite
 * GitHub Actions workflow (and any future compat suites).
 *
 * This endpoint only carries result counts. Router classification is
 * submitted separately via POST /api/compatibility/classify so that
 * classification updates aren't coupled to test runs (e.g. an override
 * fix or a Next.js ref bump can re-classify everything without re-running
 * the suite, and a fresh classification is available even when tests fail).
 *
 * Auth: requires `X-Compat-Secret` header matching the `COMPAT_INGEST_SECRET`
 * worker secret (set via `wrangler secret put COMPAT_INGEST_SECRET`).
 *
 * Body:
 *   {
 *     kind: "deploy" | string,
 *     runKey: string,         // GitHub run_id or other stable id
 *     vinextRef?: string,
 *     nextRef?: string,
 *     commitSha?: string,
 *     files: Array<{
 *       suite: string,        // test file path; joins to compat_suite_meta.suite
 *       total: number,
 *       passed: number,
 *       failed: number,
 *       skipped: number,
 *     }>,
 *   }
 *
 * `status` per file is derived: all-pass => "pass", all-fail (or any-fail with
 * 0 pass) => "fail", mixed => "partial", all-skip/zero => "skip".
 */
import { getDb } from "@/app/lib/db/client";
import { compatRuns, compatFileResults, type FileStatus } from "@/app/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireIngestAuth } from "./_auth";

type SubmitFile = {
  suite: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};

type SubmitBody = {
  kind: string;
  runKey: string;
  vinextRef?: string;
  nextRef?: string;
  commitSha?: string;
  files: SubmitFile[];
};

/**
 * Upper bound on files per submission. The full Next.js deploy suite has
 * ~800 files today; 2000 leaves headroom for growth and prevents a malicious
 * or buggy client from issuing tens of thousands of sequential D1 inserts.
 */
const MAX_FILES = 2000;

function deriveStatus(f: SubmitFile): FileStatus {
  if (f.failed > 0 && f.passed > 0) return "partial";
  if (f.failed > 0) return "fail";
  if (f.passed > 0) return "pass";
  return "skip";
}

function isValidBody(body: unknown): body is SubmitBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.kind !== "string" || b.kind.length === 0) return false;
  if (typeof b.runKey !== "string" || b.runKey.length === 0) return false;
  if (!Array.isArray(b.files)) return false;
  if (b.files.length > MAX_FILES) return false;
  for (const f of b.files) {
    if (!f || typeof f !== "object") return false;
    const fr = f as Record<string, unknown>;
    if (typeof fr.suite !== "string" || fr.suite.length === 0) return false;
    if (typeof fr.total !== "number") return false;
    if (typeof fr.passed !== "number") return false;
    if (typeof fr.failed !== "number") return false;
    if (typeof fr.skipped !== "number") return false;
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
    return await writeRun(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/compatibility] write failed:", message);
    return Response.json({ error: "Failed to persist run", detail: message }, { status: 500 });
  }
}

async function writeRun(body: SubmitBody): Promise<Response> {
  const db = getDb();
  const now = Date.now();

  // Aggregate totals.
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const f of body.files) {
    total += f.total;
    passed += f.passed;
    failed += f.failed;
    skipped += f.skipped;
  }

  // Atomic upsert by (kind, runKey). Drizzle compiles this to a single
  // INSERT ... ON CONFLICT(kind, run_key) DO UPDATE SET ... — no race
  // window between SELECT and INSERT for concurrent retried CI runs.
  const upserted = await db
    .insert(compatRuns)
    .values({
      kind: body.kind,
      runKey: body.runKey,
      vinextRef: body.vinextRef ?? null,
      nextRef: body.nextRef ?? null,
      commitSha: body.commitSha ?? null,
      createdAt: now,
      total,
      passed,
      failed,
      skipped,
    })
    .onConflictDoUpdate({
      target: [compatRuns.kind, compatRuns.runKey],
      set: {
        vinextRef: body.vinextRef ?? null,
        nextRef: body.nextRef ?? null,
        commitSha: body.commitSha ?? null,
        createdAt: now,
        total,
        passed,
        failed,
        skipped,
      },
    })
    .returning({ id: compatRuns.id });

  const runId = upserted[0].id;

  // Atomically replace this run's file results: DELETE old rows then
  // bulk INSERT the new ones. We use D1's `batch()` so all statements
  // execute inside a single transaction — if any insert fails, the DELETE
  // and earlier inserts roll back too. Without batch the worker could
  // crash between DELETE and the first INSERT, leaving a run with zero
  // files (visible as an empty grid until the next successful ingest).
  //
  // D1 enforces SQLite's 100-variable cap per statement; each row binds
  // 8 columns (runId, kind, suite, status, total, passed, failed,
  // skipped), so we can fit at most 12 rows per INSERT.
  const COLUMNS_PER_ROW = 8;
  const MAX_VARS = 100;
  const CHUNK = Math.floor(MAX_VARS / COLUMNS_PER_ROW);

  const rows = body.files.map((f) => ({
    runId,
    kind: body.kind,
    suite: f.suite,
    status: deriveStatus(f),
    total: f.total,
    passed: f.passed,
    failed: f.failed,
    skipped: f.skipped,
  }));

  // drizzle's batch() is typed as a non-empty readonly tuple — we know the
  // DELETE is always the first statement, so we cast through `unknown` at
  // the call site rather than fighting the variadic-tuple types.
  const stmts: unknown[] = [db.delete(compatFileResults).where(eq(compatFileResults.runId, runId))];
  for (let i = 0; i < rows.length; i += CHUNK) {
    stmts.push(db.insert(compatFileResults).values(rows.slice(i, i + CHUNK)));
  }
  await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);

  return Response.json({ ok: true, runId, total, passed, failed, skipped });
}
