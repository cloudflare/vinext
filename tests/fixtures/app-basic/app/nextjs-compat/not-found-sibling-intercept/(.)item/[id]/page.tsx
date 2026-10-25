import { forbidden, notFound, unauthorized } from "next/navigation";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  if (id === "metadata-missing") notFound();
  return { title: `Intercepted item ${id}` };
}

export default async function InterceptedItem({ params }: Props) {
  const { id } = await params;
  if (id === "missing") notFound();
  if (id === "forbidden") forbidden();
  if (id === "unauthorized") unauthorized();
  return <p id="not-found-sibling-intercept-intercepted">Intercepted item: {id}</p>;
}
