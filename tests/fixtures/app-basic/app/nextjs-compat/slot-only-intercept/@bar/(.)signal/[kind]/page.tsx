import { forbidden, notFound, unauthorized } from "next/navigation";

type Props = { params: Promise<{ kind: string }> };

// With no page before @bar, this intercept heads the route, yet its
// generateMetadata() signals still reach this segment's own boundaries.
export async function generateMetadata({ params }: Props) {
  const { kind } = await params;
  if (kind === "missing") notFound();
  if (kind === "forbidden") forbidden();
  if (kind === "unauthorized") unauthorized();
  return { title: `Slot only signal ${kind}` };
}

export default async function BarSignalIntercept({ params }: Props) {
  const { kind } = await params;
  return <p id="slot-only-bar-signal">signal intercept @bar: {kind}</p>;
}
