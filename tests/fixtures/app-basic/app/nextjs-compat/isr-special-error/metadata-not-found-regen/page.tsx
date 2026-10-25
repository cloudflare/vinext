import { notFound } from "next/navigation";

// An ISR page whose generateMetadata() calls notFound() once
// /api/isr-metadata-not-found-regen has been requested, so that only its
// regeneration throws.
export const revalidate = 1;

export async function generateMetadata() {
  if ((globalThis as { __vinextMetadataNotFoundRegen?: boolean }).__vinextMetadataNotFoundRegen) {
    notFound();
  }
  return { title: "metadata not-found regen" };
}

export default function Page() {
  return <p id="metadata-not-found-regen-page">metadata not-found regen page</p>;
}
