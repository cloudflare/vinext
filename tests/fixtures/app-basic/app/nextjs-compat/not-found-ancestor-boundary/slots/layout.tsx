/**
 * Test fixture: a layout with its own not-found.tsx and a @team slot. Soft
 * navigating the slot to /slots/settings keeps the children page mounted.
 */
import Link from "next/link";

export default function SlotsLayout({
  children,
  team,
}: {
  children: React.ReactNode;
  team: React.ReactNode;
}) {
  return (
    <div id="not-found-ancestor-boundary-slots">
      <Link href="/nextjs-compat/not-found-ancestor-boundary/slots">Slots home</Link>
      <Link href="/nextjs-compat/not-found-ancestor-boundary/slots/settings">Slot settings</Link>
      {children}
      {team}
    </div>
  );
}
