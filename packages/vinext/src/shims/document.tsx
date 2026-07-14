/**
 * next/document shim
 *
 * Provides Html, Head, Main, NextScript, and the class-based Document API for
 * custom Pages Router documents. Vinext's renderer replaces the Main and
 * NextScript placeholders with the rendered page and hydration scripts.
 */
import React from "react";
import type {
  DocumentContext,
  DocumentInitialProps,
  DocumentProps,
} from "@vinext/types/next/upstream/dist/shared/lib/utils";
import type { HtmlProps } from "@vinext/types/next/upstream/dist/shared/lib/html-context.shared-runtime";

export type { DocumentContext, DocumentInitialProps, DocumentProps };

export type OriginProps = {
  nonce?: string;
  crossOrigin?: "anonymous" | "use-credentials" | "" | undefined;
  children?: React.ReactNode;
};

type DocumentFiles = {
  sharedFiles: readonly string[];
  pageFiles: readonly string[];
  allFiles: readonly string[];
};

type HeadProps = OriginProps & React.ComponentPropsWithoutRef<"head">;
const HtmlContext = React.createContext<HtmlProps | undefined>(undefined);

export function Html(
  props: React.DetailedHTMLProps<React.HtmlHTMLAttributes<HTMLHtmlElement>, HTMLHtmlElement>,
): React.ReactElement {
  return <html {...props} />;
}

export class Head extends React.Component<HeadProps> {
  static contextType = HtmlContext;
  declare context: HtmlProps;

  getCssLinks(_files: DocumentFiles): React.ReactElement[] | null {
    return null;
  }

  getPreloadDynamicChunks(): Array<React.ReactElement | null> {
    return [];
  }

  getPreloadMainLinks(_files: DocumentFiles): React.ReactElement[] | null {
    return null;
  }

  getBeforeInteractiveInlineScripts(): React.ReactElement[] {
    return [];
  }

  getDynamicChunks(_files: DocumentFiles): Array<React.ReactElement | null> {
    return [];
  }

  getPreNextScripts(): React.ReactElement {
    return <></>;
  }

  getScripts(_files: DocumentFiles): React.ReactElement[] {
    return [];
  }

  getPolyfillScripts(): React.ReactElement[] {
    return [];
  }

  render(): React.ReactElement {
    const { children, ...props } = this.props;
    return <head {...props}>{children}</head>;
  }
}

export function Main(): React.ReactElement {
  return <div id="__next" dangerouslySetInnerHTML={{ __html: "__NEXT_MAIN__" }} />;
}

export class NextScript extends React.Component<OriginProps> {
  static contextType = HtmlContext;
  declare context: HtmlProps;

  getDynamicChunks(_files: DocumentFiles): Array<React.ReactElement | null> {
    return [];
  }

  getPreNextScripts(): React.ReactElement {
    return <></>;
  }

  getScripts(_files: DocumentFiles): React.ReactElement[] {
    return [];
  }

  getPolyfillScripts(): React.ReactElement[] {
    return [];
  }

  static getInlineScriptSource(context: Readonly<HtmlProps>): string {
    return JSON.stringify(context.__NEXT_DATA__);
  }

  render(): React.ReactElement {
    return <span dangerouslySetInnerHTML={{ __html: "<!-- __NEXT_SCRIPTS__ -->" }} />;
  }
}

// oxlint-disable-next-line @typescript-eslint/no-empty-object-type
export default class Document<P = {}> extends React.Component<DocumentProps & P> {
  static getInitialProps(ctx: DocumentContext): Promise<DocumentInitialProps> {
    return ctx.defaultGetInitialProps(ctx);
  }

  render(): React.ReactElement {
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
