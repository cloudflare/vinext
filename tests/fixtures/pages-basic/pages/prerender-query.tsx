import { useRouter } from "next/router";

type Props = {
  params: Record<string, string>;
};

export function getStaticProps({ params }: { params?: Record<string, string> }) {
  return {
    props: {
      params: params ?? {},
    },
  };
}

export default function PrerenderQuery({ params }: Props) {
  return (
    <>
      <pre id="params">{JSON.stringify(params)}</pre>
      <pre id="query">{JSON.stringify(useRouter().query)}</pre>
    </>
  );
}
