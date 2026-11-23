// Middleware blocks every team page (see middleware.ts).
export default async function TeamNestedPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  return <p>{`SECRET-TEAM-NESTED-CONTENT:${team}`}</p>;
}
