// The test sets this array to observe the order of events in SSR.
export function recordRenderEvent(event: string): void {
  const events: unknown = Reflect.get(globalThis, "__SEARCH_PARAMS_GATE_EVENTS__");
  if (Array.isArray(events)) events.push(event);
}
