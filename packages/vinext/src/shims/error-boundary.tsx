"use client";

import React from "react";
// Import the local shim, not the public next/navigation alias. The built
// package may execute this file before the plugin's resolveId hook is active.
import { usePathname, useRouter } from "./navigation.js";
import { getErrorDigest, isNavigationSignalError } from "../utils/navigation-signal.js";

export type ErrorBoundaryProps = {
  fallback: React.ComponentType<{ error: unknown; reset: () => void }>;
  children: React.ReactNode;
};

type CapturedError = {
  thrownValue: unknown;
};

type RedirectBoundaryState = {
  redirect: string | null;
  redirectType: "push" | "replace" | null;
};

type RedirectError = Error & {
  digest: string;
  handled?: boolean;
};

type ErrorBoundaryInnerProps = {
  pathname: string;
} & ErrorBoundaryProps;

export type ErrorBoundaryState = {
  error: CapturedError | null;
  previousPathname: string;
};

function isRedirectError(error: unknown): error is RedirectError {
  return getErrorDigest(error)?.startsWith("NEXT_REDIRECT;") ?? false;
}

function decodeRedirectTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function getURLFromRedirectError(error: RedirectError): string | null {
  const parts = error.digest.split(";");
  // vinext emits 3-part (redirect: `NEXT_REDIRECT;;<encoded>`) or 4-part
  // (permanentRedirect: `NEXT_REDIRECT;<type>;<encoded>;308`) digests;
  // Next.js emits 5-part digests (`NEXT_REDIRECT;<type>;<url>;<status>;<isClient>`).
  // vinext's `isRedirectError` is more permissive (just `startsWith("NEXT_REDIRECT;")`)
  // so we branch on length rather than always using `slice(2, -2)`.
  const encodedTarget = parts.length >= 5 ? parts.slice(2, -2).join(";") : parts[2];
  return encodedTarget ? decodeRedirectTarget(encodedTarget) : null;
}

function getRedirectTypeFromError(error: RedirectError): "push" | "replace" {
  const type = error.digest.split(";", 2)[1];
  return type === "push" ? "push" : "replace";
}

function HandleRedirect({
  redirect,
  redirectType,
}: {
  redirect: string;
  redirectType: "push" | "replace";
}) {
  const router = useRouter();

  React.useEffect(() => {
    React.startTransition(() => {
      if (redirectType === "push") {
        router.push(redirect);
      } else {
        router.replace(redirect);
      }
      // Intentionally no reset() here. The boundary stays in its "redirect
      // caught" state (rendering this component, which returns null) until
      // router.push()/replace() triggers a new render at the destination
      // route. That naturally unmounts this boundary and mounts a fresh one.
      // Calling reset() would clear the boundary state, causing React to
      // re-render children — which re-mounts the page component that threw
      // redirect() in the first place. For deterministic redirects (e.g.
      // auth guards), that creates an infinite redirect loop.
      // Matches Next.js's HandleRedirect in redirect-boundary.tsx.
    });
  }, [redirect, redirectType, router]);

  return null;
}

export class RedirectErrorBoundary extends React.Component<
  { children?: React.ReactNode },
  RedirectBoundaryState
> {
  constructor(props: { children?: React.ReactNode }) {
    super(props);
    this.state = {
      redirect: null,
      redirectType: null,
    };
  }

  static getDerivedStateFromError(error: unknown): RedirectBoundaryState {
    if (isRedirectError(error)) {
      // Next.js parity: an outer RedirectBoundary that has already started
      // handling a redirect marks the error as `handled` so that, if React
      // re-throws the same error during a retry render, an inner boundary
      // doesn't re-dispatch the same `router.replace()`. Vinext doesn't
      // currently emit `handled` itself (we never assign it on the error
      // object), but we keep the branch so behavior matches Next.js if a
      // host or future change ever does.
      if (error.handled) {
        return {
          redirect: null,
          redirectType: null,
        };
      }

      const url = getURLFromRedirectError(error);
      if (url === null) {
        // Malformed digest (e.g. `NEXT_REDIRECT;push;` with an empty URL
        // segment). The server-side parser at next-error-digest.ts:51 also
        // rejects this. Re-throw so the error reaches a regular error
        // boundary instead of being silently swallowed.
        throw error;
      }

      return {
        redirect: url,
        redirectType: getRedirectTypeFromError(error),
      };
    }

    throw error;
  }

  render() {
    const { redirect, redirectType } = this.state;
    if (redirect !== null && redirectType !== null) {
      return <HandleRedirect redirect={redirect} redirectType={redirectType} />;
    }

    return this.props.children;
  }
}

export function RedirectBoundary({ children }: { children?: React.ReactNode }) {
  return <RedirectErrorBoundary>{children}</RedirectErrorBoundary>;
}

/**
 * Generic ErrorBoundary used to wrap route segments with error.tsx.
 * This must be a client component since error boundaries use
 * componentDidCatch / getDerivedStateFromError.
 */
export class ErrorBoundaryInner extends React.Component<
  ErrorBoundaryInnerProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryInnerProps) {
    super(props);
    this.state = { error: null, previousPathname: props.pathname };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryInnerProps,
    state: ErrorBoundaryState,
  ): ErrorBoundaryState | null {
    if (props.pathname !== state.previousPathname && state.error) {
      return { error: null, previousPathname: props.pathname };
    }
    return { error: state.error, previousPathname: props.pathname };
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    // notFound(), forbidden(), unauthorized(), and redirect() must propagate
    // past error boundaries. Re-throw them so they bubble up to the
    // framework's HTTP access fallback / redirect handler.
    if (isNavigationSignalError(error)) {
      throw error;
    }
    return { error: { thrownValue: error } };
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const FallbackComponent = this.props.fallback;
      return <FallbackComponent error={this.state.error.thrownValue} reset={this.reset} />;
    }
    return this.props.children;
  }
}

export function ErrorBoundary({ fallback, children }: ErrorBoundaryProps) {
  const pathname = usePathname();
  return (
    <ErrorBoundaryInner pathname={pathname} fallback={fallback}>
      {children}
    </ErrorBoundaryInner>
  );
}

// ---------------------------------------------------------------------------
// NotFoundBoundary — catches notFound() on the client and renders not-found.tsx
// ---------------------------------------------------------------------------

type NotFoundBoundaryProps = {
  fallback: React.ReactNode;
  children: React.ReactNode;
};

type NotFoundBoundaryInnerProps = {
  pathname: string;
} & NotFoundBoundaryProps;

type NotFoundBoundaryState = {
  notFound: boolean;
  previousPathname: string;
};

/**
 * Inner class component that catches notFound() errors and renders the
 * not-found.tsx fallback. Resets when the pathname changes (client navigation)
 * so a previous notFound() doesn't permanently stick.
 *
 * The ErrorBoundary above re-throws notFound errors so they propagate up to this
 * boundary. This must be placed above the ErrorBoundary in the component tree.
 */
class NotFoundBoundaryInner extends React.Component<
  NotFoundBoundaryInnerProps,
  NotFoundBoundaryState
> {
  constructor(props: NotFoundBoundaryInnerProps) {
    super(props);
    this.state = { notFound: false, previousPathname: props.pathname };
  }

  static getDerivedStateFromProps(
    props: NotFoundBoundaryInnerProps,
    state: NotFoundBoundaryState,
  ): NotFoundBoundaryState | null {
    // Reset the boundary when the route changes so a previous notFound()
    // doesn't permanently stick after client-side navigation.
    if (props.pathname !== state.previousPathname && state.notFound) {
      return { notFound: false, previousPathname: props.pathname };
    }
    return { notFound: state.notFound, previousPathname: props.pathname };
  }

  static getDerivedStateFromError(error: unknown): Partial<NotFoundBoundaryState> {
    if (error && typeof error === "object" && "digest" in error) {
      const digest = String(error.digest);
      if (digest === "NEXT_NOT_FOUND" || digest === "NEXT_HTTP_ERROR_FALLBACK;404") {
        return { notFound: true };
      }
    }
    // Not a notFound error — re-throw so it reaches an ErrorBoundary or propagates
    throw error;
  }

  render() {
    if (this.state.notFound) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

/**
 * Wrapper that reads the current pathname and passes it to the inner class
 * component. This enables automatic reset on client-side navigation.
 */
export function NotFoundBoundary({ fallback, children }: NotFoundBoundaryProps) {
  const pathname = usePathname();
  return (
    <NotFoundBoundaryInner pathname={pathname} fallback={fallback}>
      {children}
    </NotFoundBoundaryInner>
  );
}

// ---------------------------------------------------------------------------
// ForbiddenBoundary — catches forbidden() on the client and renders forbidden.tsx
// ---------------------------------------------------------------------------

type ForbiddenBoundaryProps = {
  fallback: React.ReactNode;
  children: React.ReactNode;
};

type ForbiddenBoundaryInnerProps = {
  pathname: string;
} & ForbiddenBoundaryProps;

type ForbiddenBoundaryState = {
  forbidden: boolean;
  previousPathname: string;
};

export class ForbiddenBoundaryInner extends React.Component<
  ForbiddenBoundaryInnerProps,
  ForbiddenBoundaryState
> {
  constructor(props: ForbiddenBoundaryInnerProps) {
    super(props);
    this.state = { forbidden: false, previousPathname: props.pathname };
  }

  static getDerivedStateFromProps(
    props: ForbiddenBoundaryInnerProps,
    state: ForbiddenBoundaryState,
  ): ForbiddenBoundaryState | null {
    if (props.pathname !== state.previousPathname && state.forbidden) {
      return { forbidden: false, previousPathname: props.pathname };
    }
    return { forbidden: state.forbidden, previousPathname: props.pathname };
  }

  static getDerivedStateFromError(error: unknown): Partial<ForbiddenBoundaryState> {
    if (error && typeof error === "object" && "digest" in error) {
      const digest = String(error.digest);
      if (digest === "NEXT_HTTP_ERROR_FALLBACK;403") {
        return { forbidden: true };
      }
    }
    throw error;
  }

  render() {
    if (this.state.forbidden) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

export function ForbiddenBoundary({ fallback, children }: ForbiddenBoundaryProps) {
  const pathname = usePathname();
  return (
    <ForbiddenBoundaryInner pathname={pathname} fallback={fallback}>
      {children}
    </ForbiddenBoundaryInner>
  );
}

// ---------------------------------------------------------------------------
// UnauthorizedBoundary — catches unauthorized() on the client and renders unauthorized.tsx
// ---------------------------------------------------------------------------

type UnauthorizedBoundaryProps = {
  fallback: React.ReactNode;
  children: React.ReactNode;
};

type UnauthorizedBoundaryInnerProps = {
  pathname: string;
} & UnauthorizedBoundaryProps;

type UnauthorizedBoundaryState = {
  unauthorized: boolean;
  previousPathname: string;
};

export class UnauthorizedBoundaryInner extends React.Component<
  UnauthorizedBoundaryInnerProps,
  UnauthorizedBoundaryState
> {
  constructor(props: UnauthorizedBoundaryInnerProps) {
    super(props);
    this.state = { unauthorized: false, previousPathname: props.pathname };
  }

  static getDerivedStateFromProps(
    props: UnauthorizedBoundaryInnerProps,
    state: UnauthorizedBoundaryState,
  ): UnauthorizedBoundaryState | null {
    if (props.pathname !== state.previousPathname && state.unauthorized) {
      return { unauthorized: false, previousPathname: props.pathname };
    }
    return { unauthorized: state.unauthorized, previousPathname: props.pathname };
  }

  static getDerivedStateFromError(error: unknown): Partial<UnauthorizedBoundaryState> {
    if (error && typeof error === "object" && "digest" in error) {
      const digest = String(error.digest);
      if (digest === "NEXT_HTTP_ERROR_FALLBACK;401") {
        return { unauthorized: true };
      }
    }
    throw error;
  }

  render() {
    if (this.state.unauthorized) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

export function UnauthorizedBoundary({ fallback, children }: UnauthorizedBoundaryProps) {
  const pathname = usePathname();
  return (
    <UnauthorizedBoundaryInner pathname={pathname} fallback={fallback}>
      {children}
    </UnauthorizedBoundaryInner>
  );
}

// ---------------------------------------------------------------------------
// DevRecoveryBoundary — dev-only top-level boundary inside BrowserRoot.
// Catches any render error that isn't already handled by a user-defined
// error.tsx (or the access-fallback boundaries above), renders nothing, and
// keeps BrowserRoot mounted so HMR can dispatch a new RSC payload without a
// full page reload. Resets on resetKey change — the caller bumps that key
// (e.g. via treeState.renderId) when a fresh tree is dispatched.
//
// Routing sentinels are re-thrown so notFound()/redirect()/forbidden()/
// unauthorized() still reach their dedicated boundaries above.
// ---------------------------------------------------------------------------

export type DevRecoveryBoundaryProps = {
  resetKey: number;
  // Called from componentDidCatch with the current resetKey so the host can
  // run any pending side effects that NavigationCommitSignal would normally
  // drive on commit — most importantly the URL update for the in-flight
  // soft-nav. Without this, a navigation that fails mid-render leaves the
  // browser on the previous URL even though the boundary recovered.
  //
  // The error itself is intentionally not passed: React's onCaughtError option
  // already routes the error to the dev overlay, so this callback is only for
  // commit-side effects keyed by resetKey.
  onCatch?: (resetKey: number) => void;
  // Children come through React.Component's PropsWithChildren default; declared
  // optional so callers can pass them positionally to createElement without
  // tripping the eslint no-children-prop rule.
  children?: React.ReactNode;
};

type DevRecoveryBoundaryState = {
  error: CapturedError | null;
  previousResetKey: number;
};

export class DevRecoveryBoundary extends React.Component<
  DevRecoveryBoundaryProps,
  DevRecoveryBoundaryState
> {
  constructor(props: DevRecoveryBoundaryProps) {
    super(props);
    this.state = { error: null, previousResetKey: props.resetKey };
  }

  static getDerivedStateFromProps(
    props: DevRecoveryBoundaryProps,
    state: DevRecoveryBoundaryState,
  ): DevRecoveryBoundaryState | null {
    if (props.resetKey === state.previousResetKey) {
      return null;
    }
    return { error: null, previousResetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<DevRecoveryBoundaryState> {
    // Re-throw routing sentinels so they still reach NotFoundBoundary /
    // RedirectBoundary / Forbidden / Unauthorized above.
    if (isNavigationSignalError(error)) {
      throw error;
    }
    return { error: { thrownValue: error } };
  }

  componentDidCatch(): void {
    this.props.onCatch?.(this.props.resetKey);
  }

  render() {
    if (this.state.error) {
      // Render nothing — the dev overlay (mounted in a separate React root)
      // shows the actual error to the developer. HMR pushing a new payload
      // bumps resetKey above, clearing this state and letting the children
      // re-render with the fixed code.
      return null;
    }
    return this.props.children;
  }
}
