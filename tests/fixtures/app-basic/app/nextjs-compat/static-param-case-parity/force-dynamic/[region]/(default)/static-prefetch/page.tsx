export const dynamic = "force-dynamic";

export default async function StaticParamCaseForceDynamicPage({
  params,
}: {
  params: Promise<{ region: string }>;
}) {
  const { region } = await params;
  return <p id="static-param-case-force-dynamic">Region: {region}</p>;
}
