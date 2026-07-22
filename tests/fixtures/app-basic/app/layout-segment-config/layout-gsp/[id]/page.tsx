export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return <div data-testid="layout-segment-config-layout-gsp">Layout GSP {id}</div>;
}
