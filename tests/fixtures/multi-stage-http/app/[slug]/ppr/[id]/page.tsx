export function generateStaticParams() {
  return [{ id: "known" }];
}

export default async function PregeneratedPage({
  params,
}: {
  params: Promise<{ id: string; slug: string }>;
}) {
  const { id, slug } = await params;
  return <main>{`fresh pregenerated route:${slug}:${id}`}</main>;
}
