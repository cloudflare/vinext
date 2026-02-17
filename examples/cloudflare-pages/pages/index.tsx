import type { GetServerSidePropsResult } from "next";
import Head from "next/head";
import Link from "next/link";
import { Counter } from "../components/counter";

interface HomeProps {
  timestamp: string;
}

// Timestamps must come from getServerSideProps to avoid hydration mismatch.
// The timestamp is serialized in __NEXT_DATA__ and reused during hydration.
export async function getServerSideProps(): Promise<GetServerSidePropsResult<HomeProps>> {
  return {
    props: {
      timestamp: new Date().toISOString(),
    },
  };
}

export default function Home({ timestamp }: HomeProps) {
  return (
    <>
      <Head>
        <title>Cloudflare Pages Router</title>
      </Head>
      <h1>Hello from Pages Router on Workers!</h1>
      <p>Rendered at: {timestamp}</p>
      <Counter />
      <nav>
        <Link href="/about">About</Link>{" | "}
        <Link href="/ssr">SSR Page</Link>
      </nav>
    </>
  );
}
