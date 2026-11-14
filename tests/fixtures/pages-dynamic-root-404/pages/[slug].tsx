type Props = { slug: string };

export function getStaticPaths() {
  return { paths: [{ params: { slug: "hello" } }], fallback: "blocking" };
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}

export default function SlugPage({ slug }: Props) {
  return <p id="slug-page">slug page: {slug}</p>;
}
