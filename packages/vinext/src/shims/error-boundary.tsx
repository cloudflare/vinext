"use client";

import React from "react";
import { decodeRedirectError, isRedirectError } from "./navigation-server.js";
import { useErrorBoundaryPathname, useErrorBoundaryRouter } from "./error-boundary-navigation.js";
import DefaultGlobalError from "./default-global-error.js";
import { handleAppNavigationFailure } from "../client/app-nav-failure-handler.js";
import { VINEXT_DEV_ERROR_RECOVERY_EVENT } from "../utils/dev-error-recovery-event.js";
import { isNavigationSignalError } from "../utils/navigation-signal.js";

export type ErrorBoundaryProps = {
  fallback: React.ComponentType<{ error: unknown; reset: () => void }>;
  children: React.ReactNode;
  resetKey?: string | null;
};

export type SerializedBoundaryError = {
  digest?: string;
  message: string;
  name?: string;
  stack?: string;
};

export function SerializedErrorBoundary({
  fallback: Fallback,
  error,
}: {
  fallback: React.ComponentType<{ error: Error & { digest?: string }; reset: () => void }>;
  error: SerializedBoundaryError;
}) {
  const reconstructedError = Object.assign(new Error(error.message), {
    digest: error.digest,
    name: error.name ?? "Error",
    stack: error.stack,
  });
  return <Fallback error={reconstructedError} reset={() => globalThis.location?.reload()} />;
}

type CapturedError = {
  thrownValue: unknown;
};

type RedirectBoundaryState = {
  redirect: string | null;
  redirectType: "push" | "replace" | null;
};

type ErrorBoundaryInnerProps = {
  isImplicitRootErrorBoundary?: boolean;
  pathname: string | null;
} & ErrorBoundaryProps;

export type ErrorBoundaryState = {
  error: CapturedError | null;
  previousPathname: string | null;
  previousResetKey: string | null;
};

type BoundaryResetProps = {
  pathname: string | null;
  resetKey?: string | null;
};

type BoundaryResetState = {
  previousPathname: string | null;
  previousResetKey: string | null;
};

function normalizeBoundaryResetKey(resetKey: string | null | undefined): string | null {
  return resetKey === undefined || resetKey === null || resetKey === "" ? null : resetKey;
}

function readBoundaryResetState(props: BoundaryResetProps): BoundaryResetState {
  return {
    previousPathname: props.pathname,
    previousResetKey: normalizeBoundaryResetKey(props.resetKey),
  };
}

function shouldResetBoundary(
  nextResetState: BoundaryResetState,
  previousResetState: BoundaryResetState,
): boolean {
  const nextResetKey = normalizeBoundaryResetKey(nextResetState.previousResetKey);
  const previousResetKey = normalizeBoundaryResetKey(previousResetState.previousResetKey);

  if (nextResetKey !== null || previousResetKey !== null) {
    return nextResetKey !== previousResetKey;
  }

  return nextResetState.previousPathname !== previousResetState.previousPathname;
}

function addDevErrorRecoveryListener(listener: () => void): void {
  if (typeof window === "undefined") return;
  window.addEventListener(VINEXT_DEV_ERROR_RECOVERY_EVENT, listener);
}

function removeDevErrorRecoveryListener(listener: () => void): void {
  if (typeof window === "undefined") return;
  window.removeEventListener(VINEXT_DEV_ERROR_RECOVERY_EVENT, listener);
}

function HandleRedirect({
  redirect,
  redirectType,
  reset,
}: {
  redirect: string;
  redirectType: "push" | "replace";
  reset: () => void;
}) {
  const router = useErrorBoundaryRouter();

  React.useEffect(() => {
    React.startTransition(() => {
      if (redirectType === "push") {
        router.push(redirect);
      } else {
        router.replace(redirect);
      }
      reset();
    });
  }, [redirect, redirectType, reset, router]);

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
      if ("handled" in error && error.handled) {
        return {
          redirect: null,
          redirectType: null,
        };
      }

      const result = decodeRedirectError(error.digest);
      if (!result) {
        // Malformed digest (e.g. `NEXT_REDIRECT;push;` with an empty URL
        // segment). The server-side parser at next-error-digest.ts:51 also
        // rejects this. Re-throw so the error reaches a regular error
        // boundary instead of being silently swallowed.
        throw error;
      }

      return {
        redirect: result.url,
        redirectType: result.type,
      };
    }

    throw error;
  }

  render() {
    const { redirect, redirectType } = this.state;
    if (redirect !== null && redirectType !== null) {
      return (
        <HandleRedirect
          redirect={redirect}
          redirectType={redirectType}
          reset={() => this.setState({ redirect: null, redirectType: null })}
        />
      );
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
    this.state = {
      error: null,
      ...readBoundaryResetState(props),
    };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryInnerProps,
    state: ErrorBoundaryState,
  ): ErrorBoundaryState | null {
    const nextResetState = readBoundaryResetState(props);
    if (state.error && handleAppNavigationFailure(state.error.thrownValue)) {
      return { error: null, ...nextResetState };
    }
    if (state.error && shouldResetBoundary(nextResetState, state)) {
      return { error: null, ...nextResetState };
    }
    return {
      error: state.error,
      ...nextResetState,
    };
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

  handleDevErrorRecovery = () => {
    if (!this.state.error) return;
    this.setState({
      error: null,
      ...readBoundaryResetState(this.props),
    });
  };

  componentDidMount(): void {
    addDevErrorRecoveryListener(this.handleDevErrorRecovery);
  }

  componentWillUnmount(): void {
    removeDevErrorRecoveryListener(this.handleDevErrorRecovery);
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

export function ErrorBoundary({ fallback, children, resetKey }: ErrorBoundaryProps) {
  const pathname = useErrorBoundaryPathname();
  return (
    <ErrorBoundaryInner pathname={pathname} resetKey={resetKey} fallback={fallback}>
      {children}
    </ErrorBoundaryInner>
  );
}

// ---------------------------------------------------------------------------
// GlobalErrorBoundary — outermost root error boundary whose fallback is the
// built-in default global-error component. It guards the user's
// `app/global-error.tsx`: if that boundary itself throws while rendering,
// React unwinds to this outer boundary and renders the minimal built-in
// fallback UI instead of crashing the whole request.
//
// Mirrors Next.js, which nests the user's global-error inside an outer
// `RootErrorBoundary errorComponent={DefaultGlobalError}`:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router.tsx
// ---------------------------------------------------------------------------

export function GlobalErrorBoundary({
  fallback,
  children,
}: {
  fallback: React.ComponentType<{ error: unknown; reset: () => void }>;
  children: React.ReactNode;
}) {
  const pathname = useErrorBoundaryPathname();
  // No `resetKey`: as the outermost root boundary it resets only on pathname
  // change (the ErrorBoundaryInner default), matching Next.js's RootErrorBoundary
  // which also has no per-segment reset key.
  return (
    <ErrorBoundaryInner
      pathname={pathname}
      fallback={fallback}
      isImplicitRootErrorBoundary={fallback === DefaultGlobalError}
    >
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
  resetKey?: string | null;
};

type NotFoundBoundaryInnerProps = {
  pathname: string | null;
} & NotFoundBoundaryProps;

type NotFoundBoundaryState = {
  notFound: boolean;
  previousPathname: string | null;
  previousResetKey: string | null;
};

/**
 * Inner class component that catches notFound() errors and renders the
 * not-found.tsx fallback. Resets on the caller's segment reset key when one is
 * provided, otherwise falls back to pathname changes for legacy callers.
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
    this.state = { notFound: false, ...readBoundaryResetState(props) };
  }

  static getDerivedStateFromProps(
    props: NotFoundBoundaryInnerProps,
    state: NotFoundBoundaryState,
  ): NotFoundBoundaryState | null {
    const nextResetState = readBoundaryResetState(props);
    if (state.notFound && shouldResetBoundary(nextResetState, state)) {
      return { notFound: false, ...nextResetState };
    }
    return { notFound: state.notFound, ...nextResetState };
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
      return (
        <>
          <meta name="robots" content="noindex" />
          {this.props.fallback}
        </>
      );
    }
    return this.props.children;
  }
}

/**
 * Wrapper that reads the current pathname and passes it to the inner class
 * component. Segment reset keys own App Router remount semantics when present.
 */
export function NotFoundBoundary({ fallback, children, resetKey }: NotFoundBoundaryProps) {
  const pathname = useErrorBoundaryPathname();
  return (
    <NotFoundBoundaryInner pathname={pathname} resetKey={resetKey} fallback={fallback}>
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
  resetKey?: string | null;
};

type ForbiddenBoundaryInnerProps = {
  pathname: string | null;
} & ForbiddenBoundaryProps;

type ForbiddenBoundaryState = {
  forbidden: boolean;
  previousPathname: string | null;
  previousResetKey: string | null;
};

export class ForbiddenBoundaryInner extends React.Component<
  ForbiddenBoundaryInnerProps,
  ForbiddenBoundaryState
> {
  constructor(props: ForbiddenBoundaryInnerProps) {
    super(props);
    this.state = { forbidden: false, ...readBoundaryResetState(props) };
  }

  static getDerivedStateFromProps(
    props: ForbiddenBoundaryInnerProps,
    state: ForbiddenBoundaryState,
  ): ForbiddenBoundaryState | null {
    const nextResetState = readBoundaryResetState(props);
    if (state.forbidden && shouldResetBoundary(nextResetState, state)) {
      return { forbidden: false, ...nextResetState };
    }
    return { forbidden: state.forbidden, ...nextResetState };
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
      return (
        <>
          <meta name="robots" content="noindex" />
          {this.props.fallback}
        </>
      );
    }
    return this.props.children;
  }
}

export function ForbiddenBoundary({ fallback, children, resetKey }: ForbiddenBoundaryProps) {
  const pathname = useErrorBoundaryPathname();
  return (
    <ForbiddenBoundaryInner pathname={pathname} resetKey={resetKey} fallback={fallback}>
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
  resetKey?: string | null;
};

type UnauthorizedBoundaryInnerProps = {
  pathname: string | null;
} & UnauthorizedBoundaryProps;

type UnauthorizedBoundaryState = {
  unauthorized: boolean;
  previousPathname: string | null;
  previousResetKey: string | null;
};

export class UnauthorizedBoundaryInner extends React.Component<
  UnauthorizedBoundaryInnerProps,
  UnauthorizedBoundaryState
> {
  constructor(props: UnauthorizedBoundaryInnerProps) {
    super(props);
    this.state = { unauthorized: false, ...readBoundaryResetState(props) };
  }

  static getDerivedStateFromProps(
    props: UnauthorizedBoundaryInnerProps,
    state: UnauthorizedBoundaryState,
  ): UnauthorizedBoundaryState | null {
    const nextResetState = readBoundaryResetState(props);
    if (state.unauthorized && shouldResetBoundary(nextResetState, state)) {
      return { unauthorized: false, ...nextResetState };
    }
    return { unauthorized: state.unauthorized, ...nextResetState };
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
      return (
        <>
          <meta name="robots" content="noindex" />
          {this.props.fallback}
        </>
      );
    }
    return this.props.children;
  }
}

export function UnauthorizedBoundary({ fallback, children, resetKey }: UnauthorizedBoundaryProps) {
  const pathname = useErrorBoundaryPathname();
  return (
    <UnauthorizedBoundaryInner pathname={pathname} resetKey={resetKey} fallback={fallback}>
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
  isImplicitRootErrorBoundary?: boolean;
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

  handleDevErrorRecovery = () => {
    if (!this.state.error) return;
    this.setState({
      error: null,
      previousResetKey: this.props.resetKey,
    });
  };

  componentDidMount(): void {
    addDevErrorRecoveryListener(this.handleDevErrorRecovery);
  }

  componentWillUnmount(): void {
    removeDevErrorRecoveryListener(this.handleDevErrorRecovery);
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
