type Props = { slug: string };

export function getServerSideProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}

export default function SlugPage({ slug }: Props) {
  return <p id="slug-page">slug page: {slug}</p>;
}
