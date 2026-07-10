export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "AbC" }];
}

export default async function StaticParamCaseScalarPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <p id="static-param-case-scalar">Scalar: {slug}</p>;
}
