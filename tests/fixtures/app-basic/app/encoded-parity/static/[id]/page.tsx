export const dynamicParams = false;

export function generateStaticParams() {
  return [{ id: "a%2Fb" }];
}

export default async function EncodedStaticPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <pre data-testid="encoded-static-param">{id}</pre>;
}
