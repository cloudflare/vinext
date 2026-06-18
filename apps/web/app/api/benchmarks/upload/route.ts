import { requireIngestAuth } from "@/app/api/compatibility/_auth";
import { uploadPerformanceRun } from "@/app/lib/benchmarks/server";

export async function POST(request: Request) {
  const denied = await requireIngestAuth(request);
  if (denied) return denied;
  return uploadPerformanceRun(request);
}
