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
 *
 * Note: charset and viewport are intentionally NOT hardcoded here. Those
 * defaults are seeded by `next/head`'s `defaultHead()` and emitted alongside
 * user `<Head>` tags via `getSSRHeadHTML()`, matching Next.js's canonical
 * ordering (`<meta charset>` first, then `<meta viewport>`, then user tags,
 * all with `data-next-head=""`). See `test/e2e/next-head/index.test.ts`.
 */
export function Head({ children }: { children?: React.ReactNode }) {
  return <head>{children}</head>;
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
 * Stand-ins for Next.js's `DocumentContext` / `DocumentInitialProps`.
 * The signatures match Next.js so custom `_document.tsx` subclasses can use
 * `ctx.renderPage()` enhancers and delegate through
 * `await Document.getInitialProps(ctx)` with the expected public types.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/utils.ts
 */
export type DocumentContext = {
  // The full `DocumentContext` includes `renderPage`, `defaultGetInitialProps`,
  // and the inherited `NextPageContext` (`pathname`, `query`, `req`, `res`,
  // `err`, `asPath`, ...). They're declared as optional because the dev error
  // renderer and compatibility paths may provide only a partial context.
  renderPage: (
    options?:
      | {
          enhanceApp?: (
            App: React.ComponentType<{ children?: React.ReactNode }>,
          ) => React.ComponentType<{ children?: React.ReactNode }>;
          enhanceComponent?: (Comp: React.ComponentType<unknown>) => React.ComponentType<unknown>;
        }
      | ((Comp: React.ComponentType<unknown>) => React.ComponentType<unknown>),
  ) => DocumentInitialProps | Promise<DocumentInitialProps>;
  defaultGetInitialProps: (
    ctx: DocumentContext,
    options?: { nonce?: string },
  ) => Promise<DocumentInitialProps>;
  pathname?: string;
  query?: Record<string, string | string[] | undefined>;
  asPath?: string;
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  err?: any;
};

export type DocumentInitialProps = {
  html: string;
  head?: ReadonlyArray<React.ReactElement>;
  styles?: React.ReactElement[] | Iterable<React.ReactNode> | React.ReactElement;
};

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
 * and `render`. Generic default matches Next.js (`P = {}`).
 */
// oxlint-disable-next-line @typescript-eslint/no-empty-object-type
export default class Document<P = {}> extends React.Component<P & { children?: React.ReactNode }> {
  /**
   * `getInitialProps` is invoked by the SSR pipeline. The runtime-provided
   * `ctx.defaultGetInitialProps()` owns the page render and style collection,
   * matching Next.js's canonical CSS-in-JS integration path.
   */
  static getInitialProps(ctx: DocumentContext): Promise<DocumentInitialProps> {
    return ctx.defaultGetInitialProps(ctx);
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
