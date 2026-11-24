export const dynamicParams = false;

export function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }];
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p data-testid="shot-modal">Shot modal: {id}</p>;
}
