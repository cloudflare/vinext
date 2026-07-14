export default async function EncodedParityPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  return <pre data-testid="encoded-page-params">{JSON.stringify(path)}</pre>;
}
