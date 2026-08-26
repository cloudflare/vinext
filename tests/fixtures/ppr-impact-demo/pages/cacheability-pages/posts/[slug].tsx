export async function getStaticPaths() {
  return { fallback: false, paths: [{ params: { slug: "known" } }] };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug }, revalidate: 60 };
}

export default function PagesPost({ slug }: { slug: string }) {
  return <p id="cacheability-result">pages-post-{slug}</p>;
}
