// The first of two `fallback: false` routes a `/chain/<one segment>` path matches.
export async function getStaticPaths() {
  return { paths: [{ params: { slug: "slug-listed" } }], fallback: false };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}

export default function Page({ slug }: { slug: string }) {
  return <div id="route">chain slug: {slug}</div>;
}
