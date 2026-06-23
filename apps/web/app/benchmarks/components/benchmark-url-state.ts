export const BENCHMARK_QUERY_PARAM = "benchmark";

export function resolveSelectedBenchmark(
  benchmarkIds: readonly string[],
  requestedBenchmark: string | null,
): string | undefined {
  if (requestedBenchmark !== null && benchmarkIds.includes(requestedBenchmark)) {
    return requestedBenchmark;
  }
  return benchmarkIds[0];
}

export function benchmarkSelectionUrl(
  pathname: string,
  searchParams: URLSearchParams,
  benchmarkId: string,
  hash = "",
): string {
  const nextSearchParams = new URLSearchParams(searchParams);
  nextSearchParams.set(BENCHMARK_QUERY_PARAM, benchmarkId);
  const search = nextSearchParams.toString();
  return `${pathname}${search ? `?${search}` : ""}${hash}`;
}
