import Head from "next/head";
import Link from "next/link";

export function getStaticProps() {
  return { props: { message: "Static props from the standalone fixture." } };
}

export default function About({ message }: { message: string }) {
  return (
    <div>
      <Head>
        <title>About - Standalone</title>
      </Head>
      <h1>About Standalone</h1>
      <p>This is the about page served from standalone output.</p>
      <p>{message}</p>
      <Link href="/">Back to Home</Link>
    </div>
  );
}
