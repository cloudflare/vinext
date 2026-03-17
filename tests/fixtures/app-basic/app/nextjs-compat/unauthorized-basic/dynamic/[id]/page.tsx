import { unauthorized } from "next/navigation";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (id === "401") {
    unauthorized();
  }

  return <p id="page">{`dynamic [id]`}</p>;
}
