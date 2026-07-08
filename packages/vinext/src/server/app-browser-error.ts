import { isNavigationSignalError } from "../utils/navigation-signal.js";
import { isUnknownRecord } from "../utils/record.js";

type VinextHydrateRootErrorInfo = {
  componentStack?: string;
  errorBoundary?: unknown;
};

type HydrateRootErrorHandler = (error: unknown, errorInfo: VinextHydrateRootErrorInfo) => void;

function isImplicitRootErrorBoundary(errorInfo: VinextHydrateRootErrorInfo): boolean {
  if (!isUnknownRecord(errorInfo.errorBoundary)) return false;
  const props = errorInfo.errorBoundary.props;
  return isUnknownRecord(props) && props.isImplicitRootErrorBoundary === true;
}

function logCaughtError(error: unknown, errorInfo: VinextHydrateRootErrorInfo): void {
  console.error(error);
  if (errorInfo?.componentStack) {
    console.error("The above error occurred in a React component:\n" + errorInfo.componentStack);
  }
}

function reportGlobalError(error: unknown): void {
  if (typeof globalThis.reportError === "function") {
    globalThis.reportError(error);
    return;
  }

  console.error(error);
}

// Match Next.js's root callback: report the error globally. The optional
// navigation-failure listener handles the resulting error event when enabled.
export function createOnUncaughtError(): HydrateRootErrorHandler {
  return (error) => {
    reportGlobalError(error);
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
export function createProdOnCaughtError(
  onImplicitRootError: HydrateRootErrorHandler,
): HydrateRootErrorHandler {
  return (error, errorInfo) => {
    if (isNavigationSignalError(error)) return;
    if (isImplicitRootErrorBoundary(errorInfo)) {
      onImplicitRootError(error, errorInfo);
      return;
    }
    logCaughtError(error, errorInfo);
  };
}

export function createDevOnCaughtError(
  onCaughtError: HydrateRootErrorHandler,
  onImplicitRootError: HydrateRootErrorHandler,
): HydrateRootErrorHandler {
  return (error, errorInfo) => {
    if (isImplicitRootErrorBoundary(errorInfo)) {
      onImplicitRootError(error, errorInfo);
      return;
    }
    onCaughtError(error, errorInfo);
  };
}

export function prodOnCaughtError(error: unknown, errorInfo: VinextHydrateRootErrorInfo): void {
  if (isNavigationSignalError(error)) return;
  logCaughtError(error, errorInfo);
}

export function prodOnRecoverableError(error: unknown): void {
  reportGlobalError(error instanceof Error && error.cause !== undefined ? error.cause : error);
}
