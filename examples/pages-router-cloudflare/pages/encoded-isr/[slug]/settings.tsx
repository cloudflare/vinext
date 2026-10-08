export default function EncodedIsrSettingsPage({ slug }: { slug: string }) {
  return <p data-testid="encoded-isr">{`settings for ${slug}`}</p>;
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug }, revalidate: 60 };
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}
