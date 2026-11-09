export default function EncodedIsrArchivePage({ slug }: { slug: string }) {
  return <p data-testid="encoded-isr">{`archive for ${slug}`}</p>;
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug }, revalidate: 60 };
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}
