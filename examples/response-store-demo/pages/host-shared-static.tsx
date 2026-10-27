export function getStaticProps() {
  return { props: { renderId: crypto.randomUUID() }, revalidate: 60 };
}

export default function HostSharedStatic({ renderId }: { renderId: string }) {
  return <output data-testid="render-id">{renderId}</output>;
}
