import { notFound } from "next/navigation";

// As ../metadata-not-found-regen, for a regeneration that an html-limited
// bot triggers.
export const revalidate = 1;

export async function generateMetadata() {
  if ((globalThis as { __vinextMetadataNotFoundRegen?: boolean }).__vinextMetadataNotFoundRegen) {
    notFound();
  }
  return { title: "metadata not-found regen bot" };
}

export default function Page() {
  return <p id="metadata-not-found-regen-bot-page">metadata not-found regen bot page</p>;
}
