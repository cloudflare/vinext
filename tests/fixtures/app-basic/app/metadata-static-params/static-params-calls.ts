// Counts generateStaticParams calls so tests can check when a dynamicParams =
// false image route runs its listing.
declare global {
  var __vinextMetadataStaticParamsCalls: number | undefined;
}

export function recordStaticParamsCall(): void {
  globalThis.__vinextMetadataStaticParamsCalls =
    (globalThis.__vinextMetadataStaticParamsCalls ?? 0) + 1;
}

export function takeStaticParamsCalls(): number {
  const calls = globalThis.__vinextMetadataStaticParamsCalls ?? 0;
  globalThis.__vinextMetadataStaticParamsCalls = 0;
  return calls;
}
