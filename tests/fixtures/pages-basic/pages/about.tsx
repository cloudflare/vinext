import Head from "next/head";
import Link from "next/link";

export default function About() {
  return (
    <div>
      <Head>
        <title>About - vinext</title>
      </Head>
      <h1>About</h1>
      <p>This is the about page.</p>
      <Link href="/">Back to Home</Link>
    </div>
  );
}
