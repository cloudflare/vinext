// Tests that all route segment configs are recognized without errors
export const dynamic = "auto";
export const fetchCache = "auto";
export const maxDuration = 30;
export const preferredRegion = "auto";
export const runtime = "nodejs";

export default function ConfigTestPage() {
  return (
    <div data-testid="config-test-page">
      <h1>Config Test Page</h1>
      <p>All route segment configs are recognized.</p>
    </div>
  );
}
