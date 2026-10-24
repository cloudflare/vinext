import { notFound } from "next/navigation";

// An intercepted navigation keeps the source page's title, not this one.
export const metadata = { title: "Modal item page" };

export default async function ModalItem({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing") notFound();
  return <p id="slot-own-modal-item">Modal item {id}</p>;
}
