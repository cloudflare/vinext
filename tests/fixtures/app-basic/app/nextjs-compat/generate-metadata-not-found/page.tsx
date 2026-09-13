import { notFound } from "next/navigation";

export async function generateMetadata() {
  notFound();
}

export default function Page() {
  return "not-found-text";
}
