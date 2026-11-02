// Records generateStaticParams calls so tests can check how many listings one
// dynamicParams = false request runs.
type StaticParamsCalls = { layout: number; page: string[] };

declare global {
  var __vinextNestedGspCalls: StaticParamsCalls | undefined;
}

function calls(): StaticParamsCalls {
  globalThis.__vinextNestedGspCalls ??= { layout: 0, page: [] };
  return globalThis.__vinextNestedGspCalls;
}

export function recordLayoutCall(): void {
  calls().layout += 1;
}

export function recordPageCall(category: string): void {
  calls().page.push(category);
}

export function takeStaticParamsCalls(): StaticParamsCalls {
  const taken = calls();
  globalThis.__vinextNestedGspCalls = { layout: 0, page: [] };
  return taken;
}
