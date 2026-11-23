// Middleware blocks every team page (see middleware.ts).
export default async function TeamPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  return <p>SECRET-TEAM-CONTENT {team}</p>;
}
