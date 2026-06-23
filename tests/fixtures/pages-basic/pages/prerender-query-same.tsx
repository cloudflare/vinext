import { useRouter } from "next/router";

export function getStaticProps() {
  return { props: { params: {} } };
}

export default function PrerenderQuerySame({ params }: { params: Record<string, string> }) {
  return (
    <>
      <pre id="params">{JSON.stringify(params)}</pre>
      <pre id="query">{JSON.stringify(useRouter().query)}</pre>
    </>
  );
}
