// Ported from vercel/next.js test/e2e/basepath/pages/index.js
// (only the bits the trailing-slash replace-state test exercises).
import Link from "next/link";

export const getStaticProps = () => ({ props: { hello: "hello" } });

export default function Index({ hello }) {
  return (
    <>
      <h1 id="index-page">index page</h1>
      <p id="prop">{hello} world</p>
      <Link href="/hello" id="hello-link">
        to /hello
      </Link>
    </>
  );
}
