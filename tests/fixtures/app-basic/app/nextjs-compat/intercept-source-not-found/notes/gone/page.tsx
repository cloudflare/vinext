import { notFound } from "next/navigation";

// No loading.tsx beside it, so a hard load gets a 404 document.
export default function GoneNotePage() {
  notFound();
}
