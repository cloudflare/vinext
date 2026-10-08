export default function EncodedIsrTabPage({ slug, tab }: { slug: string; tab: string }) {
  return <p data-testid="encoded-isr">{`tab ${tab} for ${slug}`}</p>;
}

export function getStaticProps({ params }: { params: { slug: string; tab: string } }) {
  return { props: { slug: params.slug, tab: params.tab }, revalidate: 60 };
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}
