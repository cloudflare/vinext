import { notFound } from "next/navigation";

// An ISR page whose generateMetadata() calls notFound(). An html-limited bot
// blocks on metadata, so the error rejects the shell, and Next.js stores the
// 404 for everyone.
export const revalidate = 60;

export async function generateMetadata() {
  notFound();
}

export default function Page() {
  return <p id="metadata-not-found-page">metadata not-found page</p>;
}
