import { getRevalidateParityState } from "../revalidate-parity-state";

export default function RevalidateParityTarget({ renderedAt }: { renderedAt: number }) {
  return <p id="rendered-at">rendered at: {renderedAt}</p>;
}

export async function getStaticProps() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  const { mode } = getRevalidateParityState();
  if (mode === "notFound") return { notFound: true };
  if (mode === "redirect") {
    return { redirect: { destination: "/about", permanent: false } };
  }
  // Deliberately omit `revalidate`: Next.js still lets res.revalidate()
  // replace this non-expiring SSG entry.
  return { props: { renderedAt: Date.now() } };
}
