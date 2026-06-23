import { useRouter } from "next/router";

export function getStaticPaths() {
  return { paths: [{ params: { slug: "a/b" } }], fallback: "blocking" };
}

export function getStaticProps({ params }: { params?: { slug?: string } }) {
  return { props: { params: params ?? {} } };
}

export default function PrerenderQueryDynamic({ params }: { params: Record<string, string> }) {
  return (
    <>
      <pre id="params">{JSON.stringify(params)}</pre>
      <pre id="query">{JSON.stringify(useRouter().query)}</pre>
    </>
  );
}
