export const dynamicParams = false;

export function generateStaticParams() {
  return [{ region: "SE" }, { region: "DE" }];
}

export default async function CaseInsensitiveStaticParamsPage({
  params,
}: {
  params: Promise<{ region: string }>;
}) {
  const { region } = await params;
  return <p id="case-insensitive-static-param">Region: {region}</p>;
}
