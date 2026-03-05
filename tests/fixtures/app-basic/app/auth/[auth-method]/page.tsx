export default async function AuthMethodPage({
  params,
}: {
  params: Promise<{ "auth-method": string }>;
}) {
  const resolved = await params;
  return (
    <main data-testid="auth-method-page">
      <h1>Auth Method</h1>
      <p data-testid="auth-method-value">{resolved["auth-method"]}</p>
    </main>
  );
}
