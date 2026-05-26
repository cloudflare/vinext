/**
 * Ported from Next.js's built-in default not-found component:
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/builtin/not-found.tsx
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/http-access-fallback/error-fallback.tsx
 *
 * Rendered when an App Router request resolves to a 404 and the user has not
 * supplied their own `app/not-found.tsx` (or `app/global-not-found.tsx`).
 * Matches Next.js's `HTTPAccessErrorFallback` exactly: a centered 404 / message
 * pair with minified theme CSS and dark-mode media query.
 *
 * The message string `"This page could not be found."` (note the trailing
 * period) is the canonical body asserted by Next.js's deploy suite
 * (`test/e2e/app-dir/prefetching-not-found/prefetching-not-found.test.ts`,
 * `test/e2e/basepath/error-pages.test.ts`).
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

const STATUS = 404;
const MESSAGE = "This page could not be found.";

/**
 * Mirrors `<HTTPAccessErrorFallback status={404} message="This page could not be found." />`
 * from Next.js. Kept in sync with the upstream component's structure so HTML
 * snapshot diffs between Next.js and vinext stay minimal.
 */
export default function DefaultNotFound(): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("title", null, `${STATUS}: ${MESSAGE}`),
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
          STATUS,
        ),
        React.createElement(
          "div",
          { style: styles.desc },
          React.createElement("h2", { style: styles.h2 }, MESSAGE),
        ),
      ),
    ),
  );
}
