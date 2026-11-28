import { notFound } from "next/navigation";

// An ISR page whose notFound() its loading.tsx catches. The shell renders, so
// Next.js streams the document with the digest, and its static generation
// stores it as a 404.
export const revalidate = 60;

export default async function Page() {
  notFound();
}
