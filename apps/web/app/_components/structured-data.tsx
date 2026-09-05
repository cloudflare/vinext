/**
 * Emits a schema.org graph as JSON-LD. Server component — the script must be in
 * the initial HTML, not injected on hydration, or crawlers never see it.
 */
export function StructuredData({ graph }: { graph: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}
