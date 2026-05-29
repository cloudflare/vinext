import { forbidden } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  if (id === "403") {
    forbidden();
  }
  return <p id="page">escalate-forbidden [id]</p>;
}
