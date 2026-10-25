export function getStaticProps() {
  return { props: { renderId: crypto.randomUUID() }, revalidate: 60 };
}
export default function Page({ renderId }: { renderId: string }) {
  return <div data-testid="storage-render-id">{renderId}</div>;
}
