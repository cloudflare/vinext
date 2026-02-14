// Route segment config: error means any dynamic API usage should throw
export const dynamic = "error";

export default function ErrorDynamicPage() {
  return (
    <div data-testid="error-dynamic-page">
      <h1>Error Dynamic Page</h1>
      <p>This page has dynamic=error and uses no dynamic APIs.</p>
    </div>
  );
}
