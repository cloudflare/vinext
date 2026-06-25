export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <>
      <h1>Template</h1>
      <span data-testid="server-template-render-id">{crypto.randomUUID()}</span>
      {children}
    </>
  );
}
