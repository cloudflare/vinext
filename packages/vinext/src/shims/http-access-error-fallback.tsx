/**
 * Ported from Next.js's built-in HTTP access fallback UI:
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/http-access-fallback/error-fallback.tsx
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/styles/access-error-styles.ts
 *
 * Shared by the built-in not-found, forbidden and unauthorized pages: a
 * centered status / message pair with minified theme CSS and dark-mode media
 * query. Kept in sync with the upstream component's structure so HTML
 * snapshot diffs between Next.js and vinext stay minimal.
 */
import React from "react";

const styles = {
  error: {
    fontFamily:
      'system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
    height: "100vh",
    textAlign: "center" as const,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
  },
  desc: {
    display: "inline-block",
  },
  h1: {
    display: "inline-block",
    margin: "0 20px 0 0",
    padding: "0 23px 0 0",
    fontSize: 24,
    fontWeight: 500,
    verticalAlign: "top",
    lineHeight: "49px",
  },
  h2: {
    fontSize: 14,
    fontWeight: 400,
    lineHeight: "49px",
    margin: 0,
  },
} satisfies Record<string, React.CSSProperties>;

export function HTTPAccessErrorFallback({
  status,
  message,
}: {
  status: number;
  message: string;
}): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("title", null, `${status}: ${message}`),
    React.createElement(
      "div",
      { style: styles.error },
      React.createElement(
        "div",
        null,
        React.createElement("style", {
          dangerouslySetInnerHTML: {
            __html:
              "body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}",
          },
        }),
        React.createElement(
          "h1",
          {
            className: "next-error-h1",
            style: styles.h1,
          },
          status,
        ),
        React.createElement(
          "div",
          { style: styles.desc },
          React.createElement("h2", { style: styles.h2 }, message),
        ),
      ),
    ),
  );
}
