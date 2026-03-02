export default async function SignInPage({
  params,
}: {
  params: Promise<{ "sign-in"?: string[] }>;
}) {
  const resolved = await params;
  const segments = resolved["sign-in"] ?? [];
  return (
    <main data-testid="sign-in-page">
      <h1>Sign In</h1>
      <p data-testid="sign-in-segments">Segments: {segments.length}</p>
      <p data-testid="sign-in-path">Path: {segments.length > 0 ? segments.join("/") : "(root)"}</p>
    </main>
  );
}
