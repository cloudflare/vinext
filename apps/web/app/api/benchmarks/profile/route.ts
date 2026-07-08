import { getPerformanceProfile } from "@/app/lib/benchmarks/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  const benchmarkId = url.searchParams.get("benchmarkId");
  if (!runId || !benchmarkId) return new Response("Missing profile identity", { status: 400 });
  return getPerformanceProfile(runId, benchmarkId);
}
