import Head from "next/head";
import Link from "next/link";

export default function About() {
  return (
    <div>
      <Head>
        <title>About - Standalone</title>
      </Head>
      <h1>About Standalone</h1>
      <p>This is the about page served from standalone output.</p>
      <Link href="/">Back to Home</Link>
    </div>
  );
}
