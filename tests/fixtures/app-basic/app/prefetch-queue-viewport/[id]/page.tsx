// Target 9 is the `?form` destination.
export function generateStaticParams() {
  return Array.from({ length: 9 }, (_, index) => ({ id: String(index + 1) }));
}

export default async function PrefetchQueueTargetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <h1>Target {id}</h1>;
}
