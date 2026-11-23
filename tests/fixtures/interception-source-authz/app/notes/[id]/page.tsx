import { headers } from "next/headers";

// The page itself admits only trusted viewers.
export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if ((await headers()).get("x-trusted-viewer") !== "1") return <p>NOTE-LOCKED</p>;
  return <p>SECRET-NOTE-CONTENT {id}</p>;
}
