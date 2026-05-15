/**
 * POST /api/compatibility
 *
 * Ingests a compatibility test run. Called from the Next.js deploy-suite
 * GitHub Actions workflow (and any future compat suites).
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
 *       suite: string,        // test file path
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
import { getDb, getIngestSecret } from "@/app/lib/db/client";
import { compatRuns, compatFileResults, type FileStatus } from "@/app/lib/db/schema";
import { and, eq } from "drizzle-orm";

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
  const expected = getIngestSecret();
  if (!expected) {
    return Response.json(
      { error: "COMPAT_INGEST_SECRET is not configured on the worker" },
      { status: 503 },
    );
  }

  const provided = request.headers.get("x-compat-secret");
  if (provided !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return Response.json({ error: "Invalid body shape" }, { status: 400 });
  }

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

  // Upsert the run by (kind, runKey). If a run with this key already exists,
  // we delete its previous file_results and re-insert (lets a retried CI run
  // overwrite stale data cleanly).
  const existing = await db
    .select({ id: compatRuns.id })
    .from(compatRuns)
    .where(and(eq(compatRuns.kind, body.kind), eq(compatRuns.runKey, body.runKey)))
    .limit(1);

  let runId: number;
  if (existing.length > 0) {
    runId = existing[0].id;
    await db
      .update(compatRuns)
      .set({
        vinextRef: body.vinextRef ?? null,
        nextRef: body.nextRef ?? null,
        commitSha: body.commitSha ?? null,
        createdAt: now,
        total,
        passed,
        failed,
        skipped,
      })
      .where(eq(compatRuns.id, runId));
    await db.delete(compatFileResults).where(eq(compatFileResults.runId, runId));
  } else {
    const inserted = await db
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
      .returning({ id: compatRuns.id });
    runId = inserted[0].id;
  }

  // Bulk insert file results. D1 enforces SQLite's 100-variable cap per
  // statement. Each row binds 8 columns (runId, kind, suite, status, total,
  // passed, failed, skipped), so we can fit at most 12 rows per insert.
  if (body.files.length > 0) {
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
    const COLUMNS_PER_ROW = 8;
    const MAX_VARS = 100;
    const CHUNK = Math.floor(MAX_VARS / COLUMNS_PER_ROW);
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(compatFileResults).values(rows.slice(i, i + CHUNK));
    }
  }

  return Response.json({ ok: true, runId, total, passed, failed, skipped });
}
