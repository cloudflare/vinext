export default function SiblingTargetPage({ params }: { params: { id: string } }) {
  return (
    <main data-testid="sibling-target-page">
      <h1>Sibling Target {params.id}</h1>
    </main>
  );
}
