export function getStaticProps() {
  return { props: {}, revalidate: 60 };
}

export default function ConditionalRewritePage() {
  return <p>conditional rewrite source</p>;
}
