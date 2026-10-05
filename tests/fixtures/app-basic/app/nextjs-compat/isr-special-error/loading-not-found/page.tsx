import { notFound } from "next/navigation";

// An ISR page whose notFound() its loading.tsx catches. The shell renders, so
// Next.js streams and stores the document as a 200 with the digest.
export const revalidate = 60;

export default async function Page() {
  notFound();
}
