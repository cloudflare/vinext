"use client";

import React from "react";
// Import the local shim, not the public next/navigation alias. The built
// package may execute this file before the plugin's resolveId hook is active.
import { usePathname } from "./navigation.js";

export type ErrorBoundaryProps = {
  fallback: React.ComponentType<{ error: Error; reset: () => void }>;
  children: React.ReactNode;
};

type ErrorBoundaryInnerProps = {
  pathname: string;
} & ErrorBoundaryProps;

export type ErrorBoundaryState = {
  error: Error | null;
  previousPathname: string;
};

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

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // notFound(), forbidden(), unauthorized(), and redirect() must propagate
    // past error boundaries. Re-throw them so they bubble up to the
    // framework's HTTP access fallback / redirect handler.
    if (error && typeof error === "object" && "digest" in error) {
      const digest = String(error.digest);
      if (
        digest === "NEXT_NOT_FOUND" || // legacy compat
        digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;") ||
        digest.startsWith("NEXT_REDIRECT;")
      ) {
        throw error;
      }
    }
    return { error };
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const FallbackComponent = this.props.fallback;
      return <FallbackComponent error={this.state.error} reset={this.reset} />;
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

  static getDerivedStateFromError(error: Error): Partial<NotFoundBoundaryState> {
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

  static getDerivedStateFromError(error: Error): Partial<ForbiddenBoundaryState> {
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

  static getDerivedStateFromError(error: Error): Partial<UnauthorizedBoundaryState> {
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
