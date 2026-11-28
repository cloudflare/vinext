// Ported from Next.js: test/e2e/dynamic-optional-routing/pages/[[...optionalName]].js
import { useRouter } from "next/router";

type Query = { optionalName?: string[] };

export async function getServerSideProps({ query }: { query: Query }) {
  return { props: { query } };
}

export default function Page({ query }: { query: Query }) {
  return (
    <>
      <div id="route">
        top level route param:{" "}
        {query.optionalName === undefined ? "undefined" : `[${query.optionalName.join("|")}]`}
      </div>
      <div id="asPath">{useRouter().asPath}</div>
    </>
  );
}
