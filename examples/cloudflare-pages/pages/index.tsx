import Head from "next/head";
import Link from "next/link";
import { Counter } from "../components/counter";

export default function Home() {
  return (
    <>
      <Head>
        <title>Cloudflare Pages Router</title>
      </Head>
      <h1>Hello from Pages Router on Workers!</h1>
      <p>Rendered at {new Date().toISOString()}</p>
      <Counter />
      <nav>
        <Link href="/about">About</Link>{" | "}
        <Link href="/ssr">SSR Page</Link>
      </nav>
    </>
  );
}
