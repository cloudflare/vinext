/**
 * next/document shim
 *
 * Provides Html, Head, Main, NextScript components for custom _document.tsx.
 * During SSR these render placeholder markers that the dev server replaces
 * with actual content.
 */
import React from "react";

export function Html({
  children,
  lang,
  ...props
}: React.HTMLAttributes<HTMLHtmlElement> & { children?: React.ReactNode }) {
  return (
    <html lang={lang} {...props}>
      {children}
    </html>
  );
}

/**
 * Document Head - renders <head> with children.
 * The dev server injects meta tags, styles, etc.
 */
export function Head({ children }: { children?: React.ReactNode }) {
  return (
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {children}
    </head>
  );
}

/**
 * Main - renders the page content container.
 */
export function Main() {
  return <div id="__next" dangerouslySetInnerHTML={{ __html: "__NEXT_MAIN__" }} />;
}

/**
 * NextScript - renders a placeholder that the dev-server replaces with
 * actual hydration scripts (__NEXT_DATA__ + entry module).
 * Uses dangerouslySetInnerHTML so the HTML comment survives renderToString.
 */
export function NextScript() {
  return <span dangerouslySetInnerHTML={{ __html: "<!-- __NEXT_SCRIPTS__ -->" }} />;
}

/**
 * Default Document component — also the base class user `_document.tsx` files
 * `extend`. Must be a class (not a function) to match Next.js's `next/document`
 * default export so `class MyDocument extends Document` produces a constructible
 * class that React can instantiate during SSR. Returning a function here breaks
 * any user `_document.tsx` that uses the class-based form because `extends`
 * against a non-constructor produces a class that can only be called without
 * `new`, which React refuses to do.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/pages/_document.tsx
 * Ported behavior: Next.js's default `Document` is a `class Document extends
 * React.Component`. Custom documents extend it and override `getInitialProps`
 * and `render`.
 */
export default class Document<P = unknown> extends React.Component<
  P & { children?: React.ReactNode }
> {
  /**
   * `getInitialProps` is invoked by the SSR pipeline. The default implementation
   * is a no-op: subclasses replace it. Returning an empty object keeps the
   * runtime contract compatible with consumers that always call it.
   */
  static async getInitialProps(_ctx: unknown): Promise<Record<string, unknown>> {
    return {};
  }

  render(): React.ReactNode {
    return (
      <Html>
        <Head />
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
