/**
 * next/document shim
 *
 * Provides Html, Head, Main, NextScript components for custom _document.tsx.
 * During SSR these render placeholder markers that the dev server replaces
 * with actual content.
 */
import React from "react";

export type DocumentInitialProps = {
  html: string;
  head?: React.ReactNode[];
  styles?: React.ReactNode;
};

export type DocumentContext = {
  renderPage: (options?: DocumentRenderPageOptions) => Promise<DocumentInitialProps>;
};

export type DocumentRenderPageOptions =
  | ((Component: React.ComponentType) => React.ComponentType)
  | {
      enhanceApp?: (App: React.ComponentType) => React.ComponentType;
      enhanceComponent?: (Component: React.ComponentType) => React.ComponentType;
    };

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
export function Head({ children }: { children?: React.ReactNode; nonce?: string }) {
  return (
    <head>
      <meta charSet="utf-8" data-next-head="" />
      <meta name="viewport" content="width=device-width" data-next-head="" />
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
export function NextScript({ crossOrigin, nonce }: { crossOrigin?: string; nonce?: string }) {
  return React.createElement("vinext-next-scripts", {
    "data-vinext-next-script-crossorigin": crossOrigin,
    "data-vinext-next-script-nonce": nonce,
    dangerouslySetInnerHTML: { __html: "__NEXT_SCRIPTS__" },
  });
}

NextScript.getInlineScriptSource = function getInlineScriptSource(props?: {
  __NEXT_DATA__?: unknown;
}) {
  // vinext exposes `window.__NEXT_DATA__` for the Pages Router client entry.
  // Hash-based CSP code calls this helper to authorize the inline payload, so
  // it must match the inline script that vinext injects at render time.
  return `window.__NEXT_DATA__ = ${JSON.stringify(props?.__NEXT_DATA__ ?? {})}`;
};

/**
 * Default Document component - used when no custom _document.tsx exists.
 */
export default class Document<P = Record<string, unknown>> extends React.Component<P> {
  static async getInitialProps(ctx: DocumentContext): Promise<DocumentInitialProps> {
    return ctx.renderPage();
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
