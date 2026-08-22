import type { MetadataRoute } from "next";
import { desc, eq } from "drizzle-orm";
import { compatRuns, performanceRuns } from "./lib/db/schema";

const SITE_URL = "https://vinext.dev";

/**
 * Falls back to the build timestamp when D1 is unavailable. The sitemap is
 * served on every crawl, so a database hiccup must not turn it into a 500 —
 * a stale `lastmod` is far cheaper than an unreachable sitemap.
 */
const BUILD_TIME = new Date();

/**
 * Relative specifiers, and imported lazily, so this module can be unit-tested
 * outside the Worker environment. The DB
 * client imports `cloudflare:workers`, which only resolves inside the Cloudflare
 * environment; off-Worker the import rejects and every route falls back to
 * BUILD_TIME rather than failing to load at all.
 */
async function connect() {
  const { getDb } = await import("./lib/db/client");
  return getDb();
}

async function latestCompatRunAt(): Promise<Date> {
  try {
    const db = await connect();
    const [row] = await db
      .select({ createdAt: compatRuns.createdAt })
      .from(compatRuns)
      .where(eq(compatRuns.kind, "deploy"))
      .orderBy(desc(compatRuns.createdAt))
      .limit(1);
    return row ? new Date(row.createdAt) : BUILD_TIME;
  } catch {
    return BUILD_TIME;
  }
}

async function latestPerformanceRunAt(): Promise<Date> {
  try {
    const db = await connect();
    const [row] = await db
      .select({ measuredAt: performanceRuns.measuredAt })
      .from(performanceRuns)
      .where(eq(performanceRuns.kind, "main"))
      .orderBy(desc(performanceRuns.measuredAt))
      .limit(1);
    const measured = row ? new Date(row.measuredAt) : BUILD_TIME;
    return Number.isNaN(measured.getTime()) ? BUILD_TIME : measured;
  } catch {
    return BUILD_TIME;
  }
}

/**
 * `changeFrequency` and `priority` are both ignored by Google, so only
 * `lastModified` is emitted. The two dashboard pages report the timestamp of the
 * data they render rather than the deploy time, so a crawl scheduled off this
 * file tracks the data rather than the release cadence.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [compatAt, performanceAt] = await Promise.all([
    latestCompatRunAt(),
    latestPerformanceRunAt(),
  ]);

  return [
    { url: SITE_URL, lastModified: BUILD_TIME },
    { url: `${SITE_URL}/readme`, lastModified: BUILD_TIME },
    { url: `${SITE_URL}/compatibility`, lastModified: compatAt },
    { url: `${SITE_URL}/benchmarks`, lastModified: performanceAt },
  ];
}
