// Deliberately isolate-local test state. The workerd regression flips this
// after certifying the route, purges the cached response, and verifies that a
// conditional refill cannot regain public cache headers.
let useIo = false;
let renders = 0;

export function setConditionalIo(enabled: boolean): void {
  useIo = enabled;
  renders = 0;
}

export function shouldUseConditionalIo(): boolean {
  return useIo;
}

export function recordConditionalIoRender(): number {
  return ++renders;
}
