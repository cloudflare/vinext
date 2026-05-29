import { unauthorized } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  if (id === "401") {
    unauthorized();
  }
  return <p id="page">escalate-unauthorized [id]</p>;
}
