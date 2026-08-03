type Props = { renderToken: string; slug: string };

export default function MatcherExcludedPagesPage({ renderToken, slug }: Props) {
  return (
    <main data-slug={slug} data-render-token={renderToken}>
      Matcher-excluded Pages ISR page
    </main>
  );
}

export function getStaticPaths() {
  return { fallback: "blocking", paths: [] };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return {
    props: { renderToken: crypto.randomUUID(), slug: params.slug },
    revalidate: 60,
  };
}
