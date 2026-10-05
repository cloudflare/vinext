import { notFound } from "next/navigation";

// An ISR page whose generateMetadata() calls notFound(). Next.js stores it
// with the status its triggering request's metadata streaming gives it, which
// vinext can't reproduce, so it stores nothing.
export const revalidate = 60;

export async function generateMetadata() {
  notFound();
}

export default function Page() {
  return <p id="metadata-not-found-page">metadata not-found page</p>;
}
