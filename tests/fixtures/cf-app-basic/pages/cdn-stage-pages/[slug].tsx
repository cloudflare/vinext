type Props = {
  revalidateReason: string;
  renderToken: string;
  slug: string;
};

export default function CdnStagePagesPage({ revalidateReason, renderToken, slug }: Props) {
  return (
    <main
      data-render-token={renderToken}
      data-revalidate-reason={revalidateReason}
      data-slug={slug}
    >
      Pages CDN response stage render-token:{renderToken}
    </main>
  );
}

export function getStaticPaths() {
  return { fallback: "blocking", paths: [] };
}

export async function getStaticProps({
  params,
  revalidateReason,
}: {
  params: { slug: string };
  revalidateReason?: string;
}) {
  return {
    props: {
      revalidateReason: revalidateReason ?? "unknown",
      renderToken: crypto.randomUUID(),
      slug: params.slug,
    },
    revalidate: 60,
  };
}
