export default function ErrorNestedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="error-nested-layout">
      <h2>Nested Layout</h2>
      {children}
    </div>
  );
}
