// Preserve console visibility for errors caught during hydration in dev
// without re-dispatching them through Vite's overlay path.
export function devOnCaughtError(error: unknown, errorInfo: { componentStack?: string }): void {
  console.error(error);
  if (errorInfo?.componentStack) {
    console.error("The above error occurred in a React component:" + errorInfo.componentStack);
  }
}
