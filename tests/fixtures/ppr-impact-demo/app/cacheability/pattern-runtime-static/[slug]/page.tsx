export const revalidate = 60;

export function generateStaticParams() {
  return [{ slug: "generated" }];
}

export default async function PatternRuntimeStaticPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <main>runtime static {slug}</main>;
}
