"use client";

import React from "react";

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
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // notFound() and redirect() must propagate past error boundaries.
    // Re-throw them so they bubble up to the framework's not-found/redirect handler.
    if (error && typeof error === "object" && "digest" in error) {
      const digest = String((error as any).digest);
      if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_REDIRECT;")) {
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
      return (
        <FallbackComponent error={this.state.error} reset={this.reset} />
      );
    }
    return this.props.children;
  }
}
