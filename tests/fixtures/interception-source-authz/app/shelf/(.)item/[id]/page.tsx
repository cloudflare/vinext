// shelf/ has no page of its own, so another route under it carries this
// intercept.
export default async function ShelfItemModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>SHELF-ITEM-MODAL {id}</p>;
}
