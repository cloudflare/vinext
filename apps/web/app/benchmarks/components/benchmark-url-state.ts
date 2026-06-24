const BENCHMARK_QUERY_PARAM = "benchmark";
const INDIVIDUAL_RUNS_QUERY_PARAM = "runs";
const HIDDEN_INDIVIDUAL_RUNS_VALUE = "hidden";

export function resolveSelectedBenchmark(
  benchmarkIds: readonly string[],
  requestedBenchmark: string | null,
): string | undefined {
  if (requestedBenchmark !== null && benchmarkIds.includes(requestedBenchmark)) {
    return requestedBenchmark;
  }
  return benchmarkIds[0];
}

export function resolveSelectedBenchmarkFromSearch(
  benchmarkIds: readonly string[],
  search: string,
): string | undefined {
  return resolveSelectedBenchmark(
    benchmarkIds,
    new URLSearchParams(search).get(BENCHMARK_QUERY_PARAM),
  );
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

export function resolveIndividualRunsVisibilityFromSearch(search: string): boolean {
  return (
    new URLSearchParams(search).get(INDIVIDUAL_RUNS_QUERY_PARAM) !== HIDDEN_INDIVIDUAL_RUNS_VALUE
  );
}

export function individualRunsVisibilityUrl(
  pathname: string,
  searchParams: URLSearchParams,
  visible: boolean,
  hash = "",
): string {
  const nextSearchParams = new URLSearchParams(searchParams);
  if (visible) {
    nextSearchParams.delete(INDIVIDUAL_RUNS_QUERY_PARAM);
  } else {
    nextSearchParams.set(INDIVIDUAL_RUNS_QUERY_PARAM, HIDDEN_INDIVIDUAL_RUNS_VALUE);
  }
  const search = nextSearchParams.toString();
  return `${pathname}${search ? `?${search}` : ""}${hash}`;
}
