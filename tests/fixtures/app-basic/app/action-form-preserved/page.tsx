import ActionFormPreservedForm from "./form";

// Module-level counter: advances on every server render of this page. If a
// data-returning server action wrongly commits a visible router update, the
// page re-renders and this counter moves — the e2e asserts it stays flat.
let serverRenderCount = 0;

export default function ActionFormPreservedPage() {
  serverRenderCount++;
  return (
    <div>
      <h1>Action Form Preserved Test</h1>
      <p data-testid="server-render-count">Server render count: {serverRenderCount}</p>
      <ActionFormPreservedForm />
    </div>
  );
}
