/**
 * GET /api/compatibility/failures
 *
 * Returns the failing suites from the most recently ingested compatibility
 * run. The optional `kind` query parameter defaults to `deploy`.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import { compatFileResults, compatRuns } from "../../../lib/db/schema";

const DEFAULT_KIND = "deploy";

export async function GET(request: Request): Promise<Response> {
  const kind = new URL(request.url).searchParams.get("kind")?.trim() || DEFAULT_KIND;

  try {
    const db = getDb();
    const latestRuns = await db
      .select()
      .from(compatRuns)
      .where(eq(compatRuns.kind, kind))
      .orderBy(desc(compatRuns.createdAt), desc(compatRuns.id))
      .limit(1);
    const run = latestRuns[0];

    if (!run) {
      return Response.json({ kind, run: null, failures: [] });
    }

    const failures = await db
      .select({
        suite: compatFileResults.suite,
        status: compatFileResults.status,
        total: compatFileResults.total,
        passed: compatFileResults.passed,
        failed: compatFileResults.failed,
        skipped: compatFileResults.skipped,
      })
      .from(compatFileResults)
      .where(
        and(
          eq(compatFileResults.runId, run.id),
          eq(compatFileResults.kind, kind),
          gt(compatFileResults.failed, 0),
        ),
      )
      .orderBy(desc(compatFileResults.failed), compatFileResults.suite);

    return Response.json({
      kind,
      run: {
        id: run.id,
        runKey: run.runKey,
        vinextRef: run.vinextRef,
        nextRef: run.nextRef,
        commitSha: run.commitSha,
        createdAt: run.createdAt,
        total: run.total,
        passed: run.passed,
        failed: run.failed,
        skipped: run.skipped,
      },
      failures,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/compatibility/failures] query failed:", message);
    return Response.json({ error: "Failed to load failing tests" }, { status: 500 });
  }
}
