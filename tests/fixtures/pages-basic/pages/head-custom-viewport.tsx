import Head from "next/head";
import Link from "next/link";

// Issue #4593: a page-level viewport must replace the default viewport
// instead of rendering next to it.
export default function HeadCustomViewportPage() {
  return (
    <div>
      <Head>
        <title>Custom viewport - vinext</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <h1>Custom viewport</h1>
      <Link href="/about">Go to About</Link>
    </div>
  );
}
