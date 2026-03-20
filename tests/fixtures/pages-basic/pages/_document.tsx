import DocumentImpl, { Html, Head, Main, NextScript } from "next/document";
import type { DocumentContext, DocumentInitialProps } from "next/document";

type DocumentProps = DocumentInitialProps & { theme: string; pathname: string };

export default class Document extends DocumentImpl<DocumentProps> {
  static async getInitialProps(ctx: DocumentContext): Promise<DocumentProps> {
    const initialProps = await DocumentImpl.getInitialProps(ctx);

    return Promise.resolve({ ...initialProps, theme: "light", pathname: ctx.pathname });
  }

  render() {
    return (
      <Html lang="en">
        <Head>
          <meta name="description" content="A vinext test app" />
        </Head>
        <body
          className="custom-body"
          data-theme-prop={this.props.theme}
          data-pathname={this.props.pathname}
        >
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
