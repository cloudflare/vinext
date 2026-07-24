import type { DocumentContext, DocumentInitialProps } from "next/document";
import Document, { Head, Html, Main, NextScript } from "next/document";
import Script from "next/script";

import { preconnectTargets } from "@atlas/fixed/preconnect";
import { TypefacePreloads } from "@atlas/look/typeface-preloads";
import type { PaletteName } from "@atlas/palette/palette";
import { paletteForPath } from "@atlas/palette/palette-for-path";
import { readPublicSettings } from "@atlas/runtime-settings/settings";
import { trialsBootstrapSnippet } from "@atlas/trials/trials";
import { htmlLangFor, zoneFromRouteQuery } from "@atlas/zones/zone";

const CDN_ORIGIN = "https://cdn.atlas-fixture.test";

type SiteDocumentProps = {
  palette?: PaletteName | null;
  htmlLang: string;
} & DocumentInitialProps;

class SiteDocument extends Document<SiteDocumentProps> {
  static async getInitialProps(ctx: DocumentContext): Promise<SiteDocumentProps> {
    const initialProps = await Document.getInitialProps(ctx);

    const zone = zoneFromRouteQuery(ctx.query ?? {});

    return {
      ...initialProps,
      palette: paletteForPath(ctx.req?.url || "/"),
      htmlLang: htmlLangFor(zone.language),
    };
  }

  render() {
    const { trialsSnippetId, rumProbeUrl } = readPublicSettings();
    return (
      <Html lang={this.props.htmlLang}>
        <Head>
          <link rel="shortcut icon" href={`${CDN_ORIGIN}/images/favicon.ico`} />
          <TypefacePreloads />
          {preconnectTargets.map((target) => (
            <link key={target.href} {...target} />
          ))}
          {!!trialsSnippetId && (
            <Script
              id="trials-agent"
              src={`https://agents.atlas-fixture.test/${trialsSnippetId}.js`}
              strategy="beforeInteractive"
            />
          )}

          {!!rumProbeUrl && (
            <Script
              id="rum-probe"
              src={rumProbeUrl}
              crossOrigin="anonymous"
              defer={false}
              strategy="beforeInteractive"
            />
          )}

          <Script
            id="trials-manifest-bootstrap"
            strategy="beforeInteractive"
            dangerouslySetInnerHTML={{
              __html: trialsBootstrapSnippet(process.env["ATLAS_TRIALS_SDK_KEY"]),
            }}
          />
        </Head>

        <body data-stack="atlas" data-palette={this.props.palette ?? undefined}>
          <script
            type="text/javascript"
            dangerouslySetInnerHTML={{
              __html: 'document.body.dataset.scripted = "true"',
            }}
          />
          <script
            type="text/javascript"
            dangerouslySetInnerHTML={{
              __html: [
                "if (!Array.prototype.at) {",
                "  Array.prototype.at = function (n) {",
                "    n = Math.trunc(n) || 0;",
                "    if (n < 0) n += this.length;",
                "    return n >= 0 && n < this.length ? this[n] : undefined;",
                "  };",
                "}",
              ].join("\n"),
            }}
          />
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default SiteDocument;
