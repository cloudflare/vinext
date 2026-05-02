export default function SiblingTargetModal({ params }: { params: { id: string } }) {
  return (
    <aside data-testid="sibling-target-modal">
      <h2>Sibling Target Modal</h2>
      <p data-testid="sibling-target-modal-id">target-id:{params.id}</p>
    </aside>
  );
}
