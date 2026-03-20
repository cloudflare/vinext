/**
 * next/document shim
 *
 * Provides Html, Head, Main, NextScript components for custom _document.tsx.
 * During SSR these render placeholder markers that the dev server replaces
 * with actual content.
 *
 * Also exports DocumentContext, DocumentInitialProps, and the base Document
 * class for typed custom document classes that use getInitialProps.
 */
import React from "react";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DocumentInitialProps = {
  html: string;
  head?: Array<React.ReactElement | null>;
  styles?: React.ReactElement[] | Iterable<React.ReactNode> | React.ReactElement;
};

export type DocumentContext = {
  pathname: string;
  query: Record<string, string | string[] | undefined>;
  asPath?: string;
  req?: IncomingMessage;
  res?: ServerResponse;
  err?: (Error & { statusCode?: number }) | null;
  locale?: string;
  locales?: readonly string[];
  defaultLocale?: string;
  renderPage: () => DocumentInitialProps | Promise<DocumentInitialProps>;
  defaultGetInitialProps(
    ctx: DocumentContext,
    options?: { nonce?: string },
  ): Promise<DocumentInitialProps>;
};

// ─── Components ───────────────────────────────────────────────────────────────

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

// ─── Base Document class ──────────────────────────────────────────────────────

/**
 * Base Document class that custom _document.tsx classes extend.
 *
 * Provides a default getInitialProps implementation that mirrors Next.js:
 * it calls ctx.defaultGetInitialProps(ctx), which in our shim just returns
 * an empty html string (the dev server injects actual content separately).
 *
 * Custom documents can override getInitialProps to augment props:
 *
 *   static async getInitialProps(ctx: DocumentContext): Promise<DocumentProps> {
 *     const initialProps = await Document.getInitialProps(ctx);
 *     return { ...initialProps, theme: "light" };
 *   }
 */
export default class Document<P = {}> extends React.Component<DocumentInitialProps & P> {
  static async getInitialProps(ctx: DocumentContext): Promise<DocumentInitialProps> {
    return ctx.defaultGetInitialProps(ctx);
  }

  render() {
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
