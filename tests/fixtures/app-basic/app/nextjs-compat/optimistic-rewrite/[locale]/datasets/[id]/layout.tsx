export default async function DatasetLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section>
      <h2 id="dataset-header">Dataset {id}</h2>
      {children}
    </section>
  );
}
