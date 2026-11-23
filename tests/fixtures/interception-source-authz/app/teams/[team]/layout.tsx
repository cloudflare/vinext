// A team's pics render beneath this layout with the same team.
export default async function TeamLayout({
  children,
  modal,
  params,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  params: Promise<{ team: string }>;
}) {
  const { team } = await params;
  return (
    <main>
      <p>{`TEAM-LAYOUT:${team}`}</p>
      {children}
      {modal}
    </main>
  );
}
