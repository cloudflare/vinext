import { notFound } from "next/navigation";

export const revalidate = 60;

// An html-limited bot blocks on metadata, so generateMetadata()'s notFound()
// rejects the shell, and Next.js stores the 404 for everyone.
export async function generateMetadata() {
  notFound();
}

export default function SpecialErrorMetadataNotFoundPage() {
  return <p>metadata not-found page</p>;
}
