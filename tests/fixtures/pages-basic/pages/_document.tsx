import { Html, Head, Main, NextScript } from "next/document";
import Script from "next/script";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta name="description" content="A vinext test app" />
      </Head>
      <body className="custom-body">
        <Main />
        <NextScript />
        <Script id="document-after" src="/dedupe-script.js" strategy="afterInteractive" />
        <Script
          id="document-before"
          src="/dedupe-script.js?before=1"
          strategy="beforeInteractive"
        />
        <Script
          id="before-ready"
          src="/dedupe-script.js?before=ready"
          strategy="beforeInteractive"
        />
      </body>
    </Html>
  );
}
