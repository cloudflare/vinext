import { notFound } from "next/navigation";

// An ISR page whose generateMetadata() calls notFound(). Most user agents
// stream metadata, so the error doesn't reject the shell, and Next.js stores
// the 200 document with the digest.
export const revalidate = 60;

export async function generateMetadata() {
  notFound();
}

export default function Page() {
  return <p id="metadata-not-found-streaming-page">metadata not-found streaming page</p>;
}
