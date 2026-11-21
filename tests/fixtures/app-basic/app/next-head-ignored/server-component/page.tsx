import Head from "next/head";

export const metadata = {
  title: "next-head-ignored server component metadata title",
};

export default function NextHeadServerComponentPage() {
  return (
    <main>
      <Head>
        <title>server component next/head title</title>
        <meta name="next-head-server" content="applied" />
      </Head>
      <h1 id="next-head-server-component">Server component with next/head</h1>
    </main>
  );
}
