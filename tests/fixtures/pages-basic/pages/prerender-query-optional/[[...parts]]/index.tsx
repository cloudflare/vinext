import { useRouter } from "next/router";

export function getStaticPaths() {
  return { paths: [{ params: { parts: [] } }], fallback: "blocking" };
}

export function getStaticProps({ params }: { params?: { parts?: string[] } }) {
  return { props: { params: params ?? {} } };
}

export default function PrerenderQueryOptional({ params }: { params: Record<string, string[]> }) {
  return (
    <>
      <pre id="params">{JSON.stringify(params)}</pre>
      <pre id="query">{JSON.stringify(useRouter().query)}</pre>
    </>
  );
}
