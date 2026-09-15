import type { GetServerSideProps } from "next";

type Props = {
  id: string;
  renderToken: string;
};

export const getServerSideProps: GetServerSideProps<Props> = async ({ params, res }) => {
  res.setHeader("Cache-Control", "private, no-store");
  return {
    props: {
      id: String(params?.id ?? "missing"),
      renderToken: crypto.randomUUID(),
    },
  };
};

export default function DynamicPage({ id, renderToken }: Props) {
  return (
    <main>
      <h1>Dynamic vinext load test</h1>
      <output data-cache-kind="dynamic" data-id={id} data-render-token={renderToken}>
        {renderToken}
      </output>
    </main>
  );
}
