import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

// notFound() after the shell has streamed reaches the client boundary on a
// document load, not the server's not-found render.
export default async function Page() {
  await new Promise((resolve) => setTimeout(resolve, 400));
  notFound();
}
