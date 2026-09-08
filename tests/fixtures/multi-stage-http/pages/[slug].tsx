import type { GetStaticPaths, GetStaticProps } from "next";

type Props = { draftMode: boolean; renderToken: string; slug: string };

export default function StagePage({ draftMode, renderToken, slug }: Props) {
  return (
    <main data-draft-mode={String(draftMode)} data-render-token={renderToken} data-slug={slug}>
      HTTP stage render: {renderToken}
    </main>
  );
}

export const getStaticPaths: GetStaticPaths = () => ({ fallback: "blocking", paths: [] });

export const getStaticProps: GetStaticProps<Props> = ({ draftMode, params }) => ({
  props: {
    draftMode: draftMode === true,
    renderToken: crypto.randomUUID(),
    slug: String(params?.slug),
  },
  revalidate: 60,
});
