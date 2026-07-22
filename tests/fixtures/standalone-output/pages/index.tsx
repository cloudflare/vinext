import Head from "next/head";
import Link from "next/link";

export default function Home() {
  return (
    <div>
      <Head>
        <title>Standalone - vinext</title>
      </Head>
      <h1>Hello, standalone!</h1>
      <p>This app uses output: standalone mode.</p>
      <Link href="/about">Go to About</Link>
    </div>
  );
}
