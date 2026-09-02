import type { GetStaticPaths, GetStaticProps } from "next";

type Props = { renderToken: string; slug: string };

export default function StagePage({ renderToken, slug }: Props) {
  return (
    <main data-render-token={renderToken} data-slug={slug}>
      HTTP stage render: {renderToken}
    </main>
  );
}

export const getStaticPaths: GetStaticPaths = () => ({ fallback: "blocking", paths: [] });

export const getStaticProps: GetStaticProps<Props> = ({ params }) => ({
  props: {
    renderToken: crypto.randomUUID(),
    slug: String(params?.slug),
  },
  revalidate: 60,
});
