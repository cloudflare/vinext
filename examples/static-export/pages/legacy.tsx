import type { GetStaticProps, InferGetStaticPropsType } from "next";
import Head from "next/head";
import Link from "next/link";

type Props = { message: string; source: string };

export const getStaticProps = (() => ({
  props: {
    message: "This value came from getStaticProps during vinext build.",
    source: "pages/legacy.tsx",
  },
})) satisfies GetStaticProps<Props>;

export default function LegacyPage({ message, source }: InferGetStaticPropsType<typeof getStaticProps>) {
  return (
    <div className="pages-shell">
      <Head><title>Pages Router SSG · Static by design</title></Head>
      <p className="kicker">Pages Router · getStaticProps</p>
      <h1>Two routers, one static artifact.</h1>
      <p className="detail-intro">{message}</p>
      <div className="proof-panel"><p className="mono">{source} → /legacy/index.html</p></div>
      <Link className="button primary" href="/products/atlas">Open a getStaticPaths page</Link>{" "}
      <Link className="button" href="/">Back to App Router</Link>
    </div>
  );
}
