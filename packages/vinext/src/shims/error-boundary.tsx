"use client";

import React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- next/navigation is shimmed
import { usePathname } from "next/navigation";

interface ErrorBoundaryProps {
  fallback: React.ComponentType<{ error: Error; reset: () => void }>;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Generic ErrorBoundary used to wrap route segments with error.tsx.
 * This must be a client component since error boundaries use
 * componentDidCatch / getDerivedStateFromError.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // notFound(), forbidden(), unauthorized(), and redirect() must propagate
    // past error boundaries. Re-throw them so they bubble up to the
    // framework's HTTP access fallback / redirect handler.
    if (error && typeof error === "object" && "digest" in error) {
      const digest = String((error as any).digest);
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

// ---------------------------------------------------------------------------
// NotFoundBoundary — catches notFound() on the client and renders not-found.tsx
// ---------------------------------------------------------------------------

interface NotFoundBoundaryProps {
  fallback: React.ReactNode;
  children: React.ReactNode;
}

interface NotFoundBoundaryInnerProps extends NotFoundBoundaryProps {
  pathname: string;
}

interface NotFoundBoundaryState {
  notFound: boolean;
  previousPathname: string;
}

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
      const digest = String((error as any).digest);
      if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) {
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
