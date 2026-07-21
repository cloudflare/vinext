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

const documentAssetMarkerAttributes = {
  headNonce: "data-vinext-head-nonce",
  headCrossOrigin: "data-vinext-head-cross-origin",
  scriptNonce: "data-vinext-script-nonce",
  scriptCrossOrigin: "data-vinext-script-cross-origin",
} as const;

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

// oxlint-disable-next-line typescript/consistent-type-definitions, typescript/no-unsafe-declaration-merging -- type-only class augmentation avoids emitting a Babel-incompatible declare field
export interface Head {
  context: HtmlProps;
}

export class Head extends React.Component<HeadProps> {
  static contextType = HtmlContext;

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
    const { children, nonce, crossOrigin, ...props } = this.props;
    return (
      <head
        {...props}
        {...(nonce ? { [documentAssetMarkerAttributes.headNonce]: nonce } : {})}
        {...(crossOrigin ? { [documentAssetMarkerAttributes.headCrossOrigin]: crossOrigin } : {})}
      >
        {children}
      </head>
    );
  }
}

export function Main(): React.ReactElement {
  return <div id="__next" dangerouslySetInnerHTML={{ __html: "__NEXT_MAIN__" }} />;
}

// oxlint-disable-next-line typescript/consistent-type-definitions, typescript/no-unsafe-declaration-merging -- type-only class augmentation avoids emitting a Babel-incompatible declare field
export interface NextScript {
  context: HtmlProps;
}

export class NextScript extends React.Component<OriginProps> {
  static contextType = HtmlContext;

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
    const { nonce, crossOrigin } = this.props;
    return (
      <span
        {...(nonce ? { [documentAssetMarkerAttributes.scriptNonce]: nonce } : {})}
        {...(crossOrigin ? { [documentAssetMarkerAttributes.scriptCrossOrigin]: crossOrigin } : {})}
        dangerouslySetInnerHTML={{ __html: "<!-- __NEXT_SCRIPTS__ -->" }}
      />
    );
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
