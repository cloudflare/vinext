export default function EncodedSsrNewPage() {
  return <p data-testid="encoded-ssr">static encoded-ssr new</p>;
}

export function getStaticProps() {
  return { props: {} };
}
