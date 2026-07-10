export async function getStaticPaths() {
  return { paths: [], fallback: "blocking" as const };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return {
    props: { slug: params.slug },
    revalidate: 3600,
  };
}

export default function RevalidateOnlyGenerated({ slug }: { slug: string }) {
  return <p>Generated {slug}</p>;
}
