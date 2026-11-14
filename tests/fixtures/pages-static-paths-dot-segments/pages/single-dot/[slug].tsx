export async function getStaticPaths() {
  return { paths: [{ params: { slug: "." } }], fallback: false };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}

export default function SingleDotPage({ slug }: { slug: string }) {
  return <main>Single dot slug={slug}</main>;
}
