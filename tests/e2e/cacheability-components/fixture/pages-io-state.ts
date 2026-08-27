const pagesIoRenderCount = Symbol.for("vinext.test.pagesIoRenderCount");
const globalState = globalThis as typeof globalThis & { [pagesIoRenderCount]?: number };

export function readPagesIoRenderCount(): number {
  return globalState[pagesIoRenderCount] ?? 0;
}

export function resetPagesIoRenderCount(): void {
  globalState[pagesIoRenderCount] = 0;
}
