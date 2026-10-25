import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

// A slow generateMetadata() must not hold back the 404 its page throws.
export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return { title: "Slow metadata page" };
}

export default function Page() {
  notFound();
}
