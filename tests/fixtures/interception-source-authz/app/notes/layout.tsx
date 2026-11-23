// Neutral layout: the guarded content lives only in [id]/page.tsx.
export default function NotesLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <main>
      {children}
      {modal}
    </main>
  );
}
