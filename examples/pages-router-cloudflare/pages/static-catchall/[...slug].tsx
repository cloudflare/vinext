export default function StaticCatchAllPage({ slug }: { slug: string[] }) {
  return <p data-testid="static-catchall">{`static-catchall ${JSON.stringify(slug)}`}</p>;
}

export function getStaticProps({ params }: { params: { slug: string[] } }) {
  return { props: { slug: params.slug } };
}

export function getStaticPaths() {
  return {
    paths: [{ params: { slug: ["public", "item"] } }, { params: { slug: ["encoded/value"] } }],
    fallback: false,
  };
}
