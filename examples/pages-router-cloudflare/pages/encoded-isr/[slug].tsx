export default function EncodedIsrDynamicPage({ slug }: { slug: string }) {
  return <p data-testid="encoded-isr">{`dynamic encoded-isr ${slug}`}</p>;
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug }, revalidate: 60 };
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}
