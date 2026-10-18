export function getStaticPaths() {
  return { fallback: "blocking", paths: [] };
}

// No revalidate interval, so only res.revalidate() refreshes the edge copy.
export function getStaticProps() {
  return { props: { renderId: crypto.randomUUID() }, revalidate: false };
}

export default function Page({ renderId }: { renderId: string }) {
  return <div data-testid="encoded-revalidate-render-id">{renderId}</div>;
}
