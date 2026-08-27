export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return [{ slug: "ordinary" }, { slug: "special" }];
}

export default async function ConfigPublicPatternPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return <p>config policy slug: {(await params).slug}</p>;
}
