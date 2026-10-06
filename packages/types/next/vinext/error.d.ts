import type { ComponentType, ReactNode } from "react";

export { default } from "../upstream/error";
export type { ErrorProps } from "../upstream/error";

// Next.js 16.3 stabilized catchError and retry. Keep the pre-16.3 names too.
// https://github.com/vercel/next.js/blob/v16.3.6/packages/next/src/client/components/catch-error.tsx
export type ErrorInfo = {
  error: unknown;
  reset: () => void;
  retry: () => void;
};

// oxlint-disable-next-line typescript/no-explicit-any -- Match Next.js's public generic constraint exactly.
type UserProps = Record<string, any>;

export declare function catchError<P extends UserProps>(
  fallback: (props: P, errorInfo: ErrorInfo) => ReactNode,
): ComponentType<P & { children?: ReactNode }>;

// Compatibility for applications using the pre-16.3 API. Keep this out of
// ErrorInfo so values valid in Next.js remain valid for the stable API.
export declare function unstable_catchError<P extends UserProps>(
  fallback: (props: P, errorInfo: ErrorInfo & { unstable_retry: () => void }) => ReactNode,
): ComponentType<P & { children?: ReactNode }>;
