import Head from "next/head";
import Link from "next/link";

export default function Home() {
  return (
    <div>
      <Head>
        <title>Hello vinext</title>
      </Head>
      <h1>Hello, vinext!</h1>
      <p>This is a Pages Router app running on Vite.</p>
      <Link href="/about">Go to About</Link>
      <Link href="/catchall-optional/[[...slug]]" as="/catchall-optional" id="optional-root">
        Go to optional catch-all root
      </Link>
      <Link id="gssp-not-found" href="/gssp-not-found?hiding=true">
        GSSP not found
      </Link>
      <Link id="gssp-dynamic-not-found" href="/gssp-not-found/first?hiding=true">
        Dynamic GSSP not found
      </Link>
    </div>
  );
}
