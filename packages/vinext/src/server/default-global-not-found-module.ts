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
