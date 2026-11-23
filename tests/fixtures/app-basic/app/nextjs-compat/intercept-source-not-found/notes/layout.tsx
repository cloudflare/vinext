/**
 * Test fixture: the layout owning the modal slot. The note segment below it
 * keeps its own not-found.tsx and loading.tsx in place while a photo opens in
 * the modal from it.
 */
import Link from "next/link";

export default function NotesLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div id="intercept-source-not-found-layout">
      <Link href="/nextjs-compat/intercept-source-not-found/photos/1">Photo 1</Link>
      {children}
      {modal}
    </div>
  );
}
