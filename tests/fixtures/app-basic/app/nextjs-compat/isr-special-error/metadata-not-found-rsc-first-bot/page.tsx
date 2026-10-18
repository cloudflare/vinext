import { notFound } from "next/navigation";

// As ../metadata-not-found, first rendered by an html-limited bot's RSC
// request.
export const revalidate = 60;

export async function generateMetadata() {
  notFound();
}

export default function Page() {
  return <p id="metadata-not-found-rsc-first-bot-page">metadata not-found rsc-first bot page</p>;
}
