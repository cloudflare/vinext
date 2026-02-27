/**
 * Cloudflare Worker entry point for the vinext Benchmarks Dashboard.
 *
 * Handles two concerns:
 * 1. API routes (/api/upload, /api/results) with D1 database access
 * 2. All other routes delegated to the vinext RSC handler
 */
import handler from "vinext/server/app-router-entry";

interface Env {
  DB: D1Database;
  BENCHMARK_UPLOAD_TOKEN: string;
}

/** Map runner keys from the benchmark JSON to DB enum values. */
const RUNNER_MAP: Record<string, string> = {
  nextjs: "nextjs",
  vinext: "vinext",
  vinextRolldown: "vinext_rolldown",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ─── API: Upload benchmark results ─────────────────────────────────
    if (url.pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    // ─── API: Query benchmark results ──────────────────────────────────
    if (url.pathname === "/api/results" && request.method === "GET") {
      return handleResults(url, env);
    }

    // ─── API: Get single commit detail ─────────────────────────────────
    if (url.pathname.startsWith("/api/commit/") && request.method === "GET") {
      const sha = url.pathname.replace("/api/commit/", "");
      return handleCommitDetail(sha, env);
    }

    // ─── All other routes: delegate to vinext RSC handler ────────────────
    return handler.fetch(request);
  },
};

// ─── Upload handler ──────────────────────────────────────────────────────────

async function handleUpload(request: Request, env: Env): Promise<Response> {
  // Authenticate with bearer token
  const auth = request.headers.get("Authorization");
  if (!auth || auth !== `Bearer ${env.BENCHMARK_UPLOAD_TOKEN}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Extract commit info from the request (CI provides these)
  const commitSha = body.commitSha;
  const commitShort = body.commitShort || commitSha?.slice(0, 7);
  const commitMessage = body.commitMessage || "";
  const commitDate = body.commitDate || new Date().toISOString();
  const results = body.results;

  if (!commitSha || !results) {
    return Response.json(
      { error: "Missing required fields: commitSha, results" },
      { status: 400 },
    );
  }

  // Insert one row per runner, batched in a single transaction
  const inserted: string[] = [];
  const stmts: D1PreparedStatement[] = [];

  for (const [key, dbRunner] of Object.entries(RUNNER_MAP)) {
    const data = results[key];
    if (!data || Object.keys(data).length === 0) continue;

    stmts.push(
      env.DB.prepare(`
        INSERT INTO benchmark_results (
          commit_sha, commit_short, commit_message, commit_date,
          run_date, runner,
          build_time_mean, build_time_stddev, build_time_min, build_time_max,
          bundle_size_raw, bundle_size_gzip, bundle_file_count,
          dev_cold_start_ms, dev_peak_rss_kb,
          ssr_rps, ssr_ttfb_ms,
          platform, arch, node_version, cpu_count, run_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        commitSha,
        commitShort,
        commitMessage,
        commitDate,
        results.timestamp || new Date().toISOString(),
        dbRunner,
        data.buildTime?.mean ?? null,
        data.buildTime?.stddev ?? null,
        data.buildTime?.min ?? null,
        data.buildTime?.max ?? null,
        data.bundleSize?.raw ?? null,
        data.bundleSize?.gzip ?? null,
        data.bundleSize?.files ?? null,
        data.devColdStart?.meanMs ?? null,
        data.devColdStart?.meanRssKb ?? null,
        null, // ssr_rps (future)
        null, // ssr_ttfb_ms (future)
        results.system?.platform ?? null,
        results.system?.arch ?? null,
        results.system?.nodeVersion ?? null,
        results.system?.cpus ?? null,
        results.buildRuns ?? results.runs ?? null,
      ),
    );
    inserted.push(dbRunner);
  }

  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
    } catch (err) {
      console.error("DB.batch failed:", err);
      return Response.json(
        { error: "Failed to insert benchmark results" },
        { status: 500 },
      );
    }
  }

  return Response.json({ ok: true, inserted }, { status: 201 });
}

// ─── Results handler ─────────────────────────────────────────────────────────

async function handleResults(url: URL, env: Env): Promise<Response> {
  const parsedLimit = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Number.isNaN(parsedLimit) ? 50 : Math.max(1, Math.min(parsedLimit, 200));
  const runner = url.searchParams.get("runner"); // optional filter

  let query = `
    SELECT * FROM benchmark_results
    ${runner ? "WHERE runner = ?" : ""}
    ORDER BY commit_date DESC, runner ASC
    LIMIT ?
  `;
  const params: any[] = runner ? [runner, limit] : [limit];

  const { results } = await env.DB.prepare(query).bind(...params).all();

  // Group by commit for easier consumption
  const grouped = groupByCommit(results as any[]);

  return Response.json(grouped, {
    headers: {
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── Commit detail handler ───────────────────────────────────────────────────

async function handleCommitDetail(sha: string, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`
    SELECT * FROM benchmark_results
    WHERE commit_sha = ? OR commit_short = ?
    ORDER BY runner ASC
  `).bind(sha, sha).all();

  if (!results || results.length === 0) {
    return Response.json({ error: "Commit not found" }, { status: 404 });
  }

  return Response.json(results, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface BenchmarkRow {
  commit_sha: string;
  commit_short: string;
  commit_message: string;
  commit_date: string;
  run_date: string;
  runner: string;
  build_time_mean: number | null;
  bundle_size_gzip: number | null;
  dev_cold_start_ms: number | null;
  dev_peak_rss_kb: number | null;
  [key: string]: any;
}

function groupByCommit(rows: BenchmarkRow[]) {
  const map = new Map<string, any>();

  for (const row of rows) {
    if (!map.has(row.commit_sha)) {
      map.set(row.commit_sha, {
        commitSha: row.commit_sha,
        commitShort: row.commit_short,
        commitMessage: row.commit_message,
        commitDate: row.commit_date,
        runDate: row.run_date,
        runners: {},
      });
    }
    const entry = map.get(row.commit_sha)!;
    entry.runners[row.runner] = {
      buildTimeMean: row.build_time_mean,
      buildTimeStddev: row.build_time_stddev,
      buildTimeMin: row.build_time_min,
      buildTimeMax: row.build_time_max,
      bundleSizeRaw: row.bundle_size_raw,
      bundleSizeGzip: row.bundle_size_gzip,
      bundleFileCount: row.bundle_file_count,
      devColdStartMs: row.dev_cold_start_ms,
      devPeakRssKb: row.dev_peak_rss_kb,
      ssrRps: row.ssr_rps,
      ssrTtfbMs: row.ssr_ttfb_ms,
      platform: row.platform,
      arch: row.arch,
      nodeVersion: row.node_version,
      cpuCount: row.cpu_count,
      runCount: row.run_count,
    };
  }

  return Array.from(map.values());
}
