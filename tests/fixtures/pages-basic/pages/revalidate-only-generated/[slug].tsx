export async function getStaticPaths() {
  return { paths: [], fallback: "blocking" as const };
}

let generation = 0;

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return {
    props: { generation: ++generation, slug: params.slug },
    revalidate: 3600,
  };
}

export default function RevalidateOnlyGenerated({
  generation,
  slug,
}: {
  generation: number;
  slug: string;
}) {
  return (
    <p>
      Generated {slug} <span data-testid="generation">{generation}</span>
    </p>
  );
}
