type Props = { slug: string };

export function getStaticPaths() {
  // The second path is the one vinext requests for the 404 page: a route
  // generating it still renders it as a page.
  return {
    paths: [{ params: { slug: "hello" } }, { params: { slug: "__vinext_nonexistent_for_404__" } }],
    fallback: "blocking",
  };
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}

export default function SlugPage({ slug }: Props) {
  return <p id="slug-page">slug page: {slug}</p>;
}
