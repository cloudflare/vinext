export const revalidate = 300;

export function generateStaticParams() {
  return [{ slug: "known" }];
}

export default async function BareFetchPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const response = await fetch(`data:text/plain,cache-probe bare fetch ${slug}`);
  return <main>{await response.text()}</main>;
}
