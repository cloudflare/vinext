import { forbidden, notFound, unauthorized } from "next/navigation";

// An intercepted navigation keeps the source page's title, not this one. A
// notFound(), forbidden(), unauthorized() or other error from here still
// reaches this route's own boundary in the modal.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "meta-missing") notFound();
  if (id === "meta-forbidden") forbidden();
  if (id === "meta-unauthorized") unauthorized();
  if (id === "meta-error") throw new Error("modal metadata error");
  return { title: "Modal item page" };
}

export default async function ModalItem({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing") notFound();
  return <p id="slot-own-modal-item">Modal item {id}</p>;
}
