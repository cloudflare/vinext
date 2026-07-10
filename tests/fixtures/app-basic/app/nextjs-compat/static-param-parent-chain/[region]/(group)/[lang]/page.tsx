export const dynamicParams = false;

export default async function StaticParamParentChainPage({
  params,
}: {
  params: Promise<{ region: string; lang: string }>;
}) {
  const { region, lang } = await params;
  return (
    <p id="static-param-parent-chain">
      Parent chain: {region}/{lang}
    </p>
  );
}
