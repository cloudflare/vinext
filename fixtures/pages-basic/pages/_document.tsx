import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta name="description" content="A vinext test app" />
      </Head>
      <body className="custom-body">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
