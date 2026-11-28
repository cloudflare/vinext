// Ported from Next.js: test/e2e/fallback-false-rewrite/pages/another.js
import { useRouter } from "next/router";

export const getServerSideProps = () => ({ props: {} });

export default function Page() {
  return (
    <>
      <p id="another">another</p>
      <p id="query">{JSON.stringify(useRouter().query)}</p>
    </>
  );
}
