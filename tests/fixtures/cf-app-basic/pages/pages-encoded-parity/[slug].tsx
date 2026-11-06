type Props = { slug: string };

export default function PagesEncodedParityPage({ slug }: Props) {
  return <main data-slug={slug}>Pages encoded parity</main>;
}

export function getServerSideProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}
