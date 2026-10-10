export function generateStaticParams() {
  return [{ section: "guides" }];
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return (
    <main>
      <h1>Section</h1>
      <p>Section: {section}</p>
    </main>
  );
}
