import { notFound } from "next/navigation";

// An ISR page whose notFound() rejects the shell, first rendered by an RSC
// request. Next.js stores its RSC payload with status 404.
export const revalidate = 60;

export default function Page() {
  notFound();
}
