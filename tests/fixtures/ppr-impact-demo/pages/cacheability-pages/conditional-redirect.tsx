export function getStaticProps() {
  return { props: {}, revalidate: 60 };
}

export default function ConditionalRedirectPage() {
  return <p>conditional redirect source</p>;
}
