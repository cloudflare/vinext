export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div>Intercepted sub target {id}</div>;
}
