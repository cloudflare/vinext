/**
 * GET /api/compatibility/failures
 *
 * Returns the failing suites from the most recently ingested compatibility
 * run. The optional `kind` query parameter defaults to `deploy`, and the
 * optional `version` query parameter (a Next.js ref) defaults to the version
 * /compatibility shows publicly.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { tracing } from "cloudflare:workers";
import { resolveNextRef } from "../../../lib/compat-version";
import { getDb } from "../../../lib/db/client";
import { compatFileResults, compatRuns } from "../../../lib/db/schema";

const DEFAULT_KIND = "deploy";

export async function GET(request: Request): Promise<Response> {
  return tracing.enterSpan("vinext.web.compatibilityFailures", async () => {
    const searchParams = new URL(request.url).searchParams;
    const kind = searchParams.get("kind")?.trim() || DEFAULT_KIND;
    const nextRef = resolveNextRef(searchParams.get("version"));

    try {
      const db = getDb();
      const latestRuns = await db
        .select()
        .from(compatRuns)
        .where(and(eq(compatRuns.kind, kind), eq(compatRuns.nextRef, nextRef)))
        .orderBy(desc(compatRuns.createdAt), desc(compatRuns.id))
        .limit(1);
      const run = latestRuns[0];

      if (!run) {
        return Response.json({ kind, nextRef, run: null, failures: [] });
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
        nextRef,
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
  });
}
