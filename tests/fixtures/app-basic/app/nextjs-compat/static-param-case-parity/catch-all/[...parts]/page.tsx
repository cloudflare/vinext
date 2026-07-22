export const dynamicParams = false;

export function generateStaticParams() {
  return [{ parts: ["AbC", "DeF"] }];
}

export default async function StaticParamCaseCatchAllPage({
  params,
}: {
  params: Promise<{ parts: string[] }>;
}) {
  const { parts } = await params;
  return <p id="static-param-case-catch-all">Catch all: {parts.join("/")}</p>;
}
