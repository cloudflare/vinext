import Head from "next/head";

export default function PageWithTitle() {
  return (
    <>
      <Head>
        <title>Route Announcer Page With Title</title>
      </Head>
      <p id="page-with-title">A page with a title but no h1</p>
    </>
  );
}
