export default function DocsPage({ slug }: { slug: string[] }) {
  return (
    <div>
      <h1 data-testid="docs-title">Docs</h1>
      <p data-testid="docs-slug">Path: {slug.join("/")}</p>
    </div>
  );
}

export async function getServerSideProps({ params }: { params: { slug: string[] } }) {
  return {
    props: {
      slug: params.slug,
    },
  };
}
