// A revalidated `dynamic = "error"` route whose team slot calls notFound()
// once the test marks the team missing, caught by the slot's own not-found
// file, which reads the request headers.
export default function Layout({
  children,
  team,
}: {
  children: React.ReactNode;
  team: React.ReactNode;
}) {
  return (
    <div>
      <main>{children}</main>
      <section>{team}</section>
    </div>
  );
}
