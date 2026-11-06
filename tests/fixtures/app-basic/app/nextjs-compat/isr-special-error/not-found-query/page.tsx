import { notFound } from "next/navigation";

// An ISR page whose notFound() rejects the shell, first requested with a
// query. Its stored 404 document must not carry that query.
export const revalidate = 60;

export default function Page() {
  notFound();
}
