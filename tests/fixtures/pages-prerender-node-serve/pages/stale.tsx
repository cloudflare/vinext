export default function StalePage({ renderedAt }: { renderedAt: string }) {
  return <p id="rendered-at">{renderedAt}</p>;
}

export function getStaticProps() {
  return { props: { renderedAt: new Date().toISOString() }, revalidate: 60 };
}
