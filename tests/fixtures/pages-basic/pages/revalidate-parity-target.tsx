import {
  getRevalidateParityState,
  incrementRevalidateParityGenerationCount,
} from "../revalidate-parity-state";

export default function RevalidateParityTarget({ renderedAt }: { renderedAt: number }) {
  return <p id="rendered-at">rendered at: {renderedAt}</p>;
}

export async function getStaticProps() {
  incrementRevalidateParityGenerationCount();
  const { mode } = getRevalidateParityState();
  await new Promise((resolve) => setTimeout(resolve, mode === "concurrent" ? 300 : 50));
  if (mode === "error") throw new Error("intentional revalidation failure");
  if (mode === "notFound") return { notFound: true };
  if (mode === "redirect") {
    return { redirect: { destination: "/about", permanent: false } };
  }
  if (mode === "externalRedirect") {
    return {
      redirect: { destination: "https://example.com/revalidated", permanent: false },
    };
  }
  // Deliberately omit `revalidate`: Next.js still lets res.revalidate()
  // replace this non-expiring SSG entry.
  return { props: { renderedAt: Date.now() } };
}
