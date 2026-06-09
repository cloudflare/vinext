import { isNavigationSignalError } from "../utils/navigation-signal.js";

// Build the onUncaughtError handler for hydrateRoot. When a render error
// tears down the tree without an error boundary catching, the
// NavigationCommitSignal layout effect never runs, so the URL update for
// the in-flight navigation is lost — the user sees a blank page on the
// previous URL. Hard-navigate to the intended target so the server can
// render its actual error UI for that route. getRecoveryHref reads the
// in-flight navigation target and returns null when nothing is pending
// (e.g. an error during initial hydration).
//
// This is the *prod* handler. The dev variant lives in dev-error-overlay.tsx
// alongside the rest of the dev-only overlay code so the entire overlay
// module — including its React component tree, createRoot import, and inline
// CSS — is structurally unreachable in production builds.
export function createOnUncaughtError(
  getRecoveryHref: () => string | null,
): (error: unknown, errorInfo: { componentStack?: string }) => void {
  return (error, errorInfo) => {
    console.error(error);
    if (errorInfo?.componentStack) {
      console.error("The above error occurred in a React component:\n" + errorInfo.componentStack);
    }
    const recoveryHref = getRecoveryHref();
    if (recoveryHref !== null) {
      window.location.assign(recoveryHref);
    }
  };
}

// Production onCaughtError handler for hydrateRoot. React calls this for
// every error caught by an error boundary. Navigation sentinel errors
// (redirect(), notFound(), forbidden(), unauthorized()) are intentionally
// thrown as control flow and MUST be caught by their dedicated boundaries;
// logging them to the console would produce spurious browser console errors
// that break the "no console errors" assertion in Next.js compat tests
// (e.g. root-layout-redirect). Filter them out silently — the boundary has
// already consumed the error and triggered the appropriate navigation.
//
// All other caught errors are logged to console.error, preserving React's
// default behavior.
export function prodOnCaughtError(error: unknown, errorInfo: { componentStack?: string }): void {
  if (isNavigationSignalError(error)) return;
  console.error(error);
  if (errorInfo?.componentStack) {
    console.error("The above error occurred in a React component:\n" + errorInfo.componentStack);
  }
}
