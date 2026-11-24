export const dynamic = "force-dynamic";

export default function InterceptionTraverseReloadPlainPage() {
  return (
    <div id="interception-traverse-reload-plain">
      <h1>Plain</h1>
      <p id="interception-traverse-reload-plain-render">{crypto.randomUUID()}</p>
    </div>
  );
}
