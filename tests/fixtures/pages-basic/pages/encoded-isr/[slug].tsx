export default function EncodedIsrDynamicPage({ slug }: { slug: string }) {
  return <p data-testid="encoded-isr">{`dynamic encoded-isr ${slug}`}</p>;
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  // The literal `target` page owns this pathname.
  if (params.slug === "target") return { notFound: true, revalidate: 60 };
  return { props: { slug: params.slug }, revalidate: 60 };
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}
