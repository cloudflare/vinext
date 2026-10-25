export default function EncodedSsrPage({ slug }: { slug: string }) {
  return <p data-testid="encoded-ssr">{`request-time encoded-ssr ${slug}`}</p>;
}

export function getServerSideProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}
