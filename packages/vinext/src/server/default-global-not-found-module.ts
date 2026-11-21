import React from "react";
import DefaultNotFound from "vinext/shims/default-not-found";

function DefaultGlobalNotFound(): React.ReactElement {
  return React.createElement(
    "html",
    null,
    React.createElement("body", null, React.createElement(DefaultNotFound)),
  );
}

/**
 * Module-shaped wrapper around Next.js's built-in global not-found document.
 * Unlike the regular default not-found boundary, this component owns the
 * document shell because global not-found responses skip the root layout.
 */
export const DEFAULT_GLOBAL_NOT_FOUND_MODULE = {
  default: DefaultGlobalNotFound,
} as const;

// Next.js' default layout, which supplies the document for a 404 page in an
// app without `app/layout`.
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/client/components/builtin/layout.tsx
function DefaultLayout({ children }: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement("html", null, React.createElement("body", null, children));
}

/**
 * `app/not-found` inside Next.js' default layout, as its /_not-found page
 * renders it in an app without `app/layout`.
 */
export function withDefaultLayout<TModule extends { default?: unknown }>(
  notFoundModule: TModule,
): TModule {
  const NotFound = notFoundModule.default as React.ComponentType | undefined;
  if (!NotFound) return notFoundModule;
  return {
    ...notFoundModule,
    default: function AppNotFound(): React.ReactElement {
      return React.createElement(DefaultLayout, null, React.createElement(NotFound));
    },
  };
}
