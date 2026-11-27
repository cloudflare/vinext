// The owner's layout is part of the intercept's tree, so the intercept renders dynamically.
export const dynamic = "force-dynamic";

export default function DeckLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
