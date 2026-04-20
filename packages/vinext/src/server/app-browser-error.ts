// Preserve console visibility for errors caught during hydration in dev
// without re-dispatching them through Vite's overlay path.
//
// Note: sentinel errors (NEXT_NOT_FOUND, NEXT_REDIRECT, etc.) are re-thrown
// in getDerivedStateFromError before they reach onCaughtError, so they will
// not appear here in practice.
export function devOnCaughtError(
  error: unknown,
  errorInfo: { componentStack?: string; errorBoundary?: unknown },
): void {
  console.error(error);
  if (errorInfo?.componentStack) {
    console.error("The above error occurred in a React component:\n" + errorInfo.componentStack);
  }
}
