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
 * Loose stand-ins for Next.js's `DocumentContext` / `DocumentInitialProps`.
 * The shim doesn't currently invoke `getInitialProps` on user `_document.tsx`
 * files (separate gap), but the signatures here match Next.js's so subclasses
 * that delegate via `await Document.getInitialProps(ctx)` typecheck against
 * the same shape they'd see under real Next.js.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/utils.ts
 */
export type DocumentContext = {
  // The full `DocumentContext` includes `renderPage`, `defaultGetInitialProps`,
  // and the inherited `NextPageContext` (`pathname`, `query`, `req`, `res`,
  // `err`, `asPath`, ...). They're declared as optional here because vinext
  // does not yet plumb them through; widening to optional avoids forcing user
  // code to assert their presence.
  renderPage?: (options?: {
    enhanceApp?: (App: React.ComponentType<{ children?: React.ReactNode }>) => unknown;
    enhanceComponent?: (Comp: React.ComponentType<unknown>) => unknown;
  }) => { html: string; head?: ReadonlyArray<React.ReactElement> };
  defaultGetInitialProps?: (
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
   * `getInitialProps` is invoked by the SSR pipeline. The default implementation
   * is a stub: vinext does not yet plumb the Pages Router `renderPage` /
   * `defaultGetInitialProps` chain into the SSR entry, so subclasses that
   * delegate via `await Document.getInitialProps(ctx)` receive an empty shell
   * (`html: ""`). This matches the runtime contract user code expects without
   * pretending the chain is wired up.
   */
  static async getInitialProps(_ctx: DocumentContext): Promise<DocumentInitialProps> {
    return { html: "" };
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
