import {
  getRevalidateParityState,
  incrementRevalidateParityGenerationCount,
} from "../revalidate-parity-state";

export default function RevalidateParityTarget({ renderedAt }: { renderedAt: number }) {
  return <p id="rendered-at">rendered at: {renderedAt}</p>;
}

export async function getStaticProps() {
  incrementRevalidateParityGenerationCount();
  const { mode, revalidate } = getRevalidateParityState();
  const withRevalidate = <T extends Record<string, unknown>>(result: T) =>
    revalidate === undefined ? result : { ...result, revalidate };
  await new Promise((resolve) => setTimeout(resolve, mode === "concurrent" ? 300 : 50));
  if (mode === "error") throw new Error("intentional revalidation failure");
  if (mode === "notFound") return withRevalidate({ notFound: true });
  if (mode === "redirect") {
    return withRevalidate({ redirect: { destination: "/about", permanent: false } });
  }
  if (mode === "permanentRedirect") {
    return withRevalidate({ redirect: { destination: "/about", permanent: true } });
  }
  if (mode === "basePathFalseRedirect") {
    return withRevalidate({
      redirect: { destination: "/about", permanent: false, basePath: false },
    });
  }
  if (mode === "conflictingRedirect") {
    return withRevalidate({
      redirect: { destination: "/about", permanent: true, statusCode: 308 },
    });
  }
  if (mode === "invalidStatusRedirect") {
    return withRevalidate({ redirect: { destination: "/about", statusCode: 304 } });
  }
  if (mode === "externalRedirect") {
    return withRevalidate({
      redirect: { destination: "https://example.com/revalidated", permanent: false },
    });
  }
  if (mode === "promised") {
    return withRevalidate({ props: Promise.resolve({ renderedAt: Date.now() }) });
  }
  return withRevalidate({ props: { renderedAt: Date.now() } });
}
