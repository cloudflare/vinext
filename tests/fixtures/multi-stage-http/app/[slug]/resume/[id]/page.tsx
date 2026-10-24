export function generateStaticParams() {
  return [{ id: "known" }];
}

export default async function ResumePage({
  params,
}: {
  params: Promise<{ id: string; slug: string }>;
}) {
  const { id, slug } = await params;
  return <main>{`resumed route:${slug}:${id}`}</main>;
}
