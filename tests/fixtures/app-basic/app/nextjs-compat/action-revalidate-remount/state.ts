let serverRenderCount = 0;

export function nextServerRenderCount(): number {
  return ++serverRenderCount;
}
