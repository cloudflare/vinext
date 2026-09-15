import type { GetServerSideProps } from "next";

type Props = {
  id: string;
  renderToken: string;
};

export const getServerSideProps: GetServerSideProps<Props> = async ({ params, res }) => {
  res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=15");
  return {
    props: {
      id: String(params?.id ?? "missing"),
      renderToken: crypto.randomUUID(),
    },
  };
};

export default function CacheablePage({ id, renderToken }: Props) {
  return (
    <main>
      <h1>Response Store load test</h1>
      <output data-cache-kind="cacheable" data-id={id} data-render-token={renderToken}>
        {renderToken}
      </output>
    </main>
  );
}
