import { notFound } from "next/navigation";

export const revalidate = 60;

// Next.js stores this page's 404 and answers a Link's segment prefetch of it
// with a 200.
export default function SpecialErrorNotFoundPage() {
  notFound();
}
