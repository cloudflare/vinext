// A `fallback: false` page ahead of an ISR catch-all for one-segment paths.
export async function getStaticPaths() {
  return { paths: [{ params: { slug: "slug-listed" } }], fallback: false };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}

export default function Page({ slug }: { slug: string }) {
  return <div id="route">isr slug: {slug}</div>;
}
