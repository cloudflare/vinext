export default async function DynamicLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <section>
      <h2 id="dynamic-layout-slug">Dynamic layout slug: {slug}</h2>
      {children}
    </section>
  );
}
