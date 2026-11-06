import { notFound } from "next/navigation";

// An ISR page whose notFound() rejects the shell. Next.js stores its render
// with status 404.
export const revalidate = 60;

export default function Page() {
  notFound();
}
