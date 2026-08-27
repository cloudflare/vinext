export function generateStaticParams() {
  return [];
}

export default async function StaticEmptyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <main>{`empty fallback ${slug}`}</main>;
}
