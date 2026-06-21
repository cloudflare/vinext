export default function MixedCatchAll({ category, slug }: { category: string; slug: string[] }) {
  return (
    <main>
      <p id="category">Category: {category}</p>
      <p id="slug">Slug: [{slug.join(", ")}]</p>
    </main>
  );
}

export async function getStaticPaths() {
  return {
    paths: [{ params: { slug: [] } }, { params: { category: "guides", slug: [] } }],
    fallback: false,
  };
}

export async function getStaticProps({
  params,
}: {
  params: { category: string; slug?: string[] };
}) {
  return {
    props: {
      category: params.category,
      slug: params.slug ?? [],
    },
  };
}
