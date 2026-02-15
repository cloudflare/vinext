import { ThrowingComponent } from "./throwing-component";

export default function ErrorTestPage() {
  return (
    <main>
      <h1>Error Test Page</h1>
      <p data-testid="error-content">This page has an error boundary.</p>
      <ThrowingComponent />
    </main>
  );
}
