export const revalidate = 300;

export function generateStaticParams() {
  return [{ slug: "known" }];
}

export default async function CacheProbeStaticPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <main>cache-probe static params {slug}</main>;
}
