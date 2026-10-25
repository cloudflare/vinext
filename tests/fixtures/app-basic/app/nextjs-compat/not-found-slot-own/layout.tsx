import Link from "next/link";

const BASE = "/nextjs-compat/not-found-slot-own";

export const metadata = { title: "Slot own layout" };

/**
 * Test fixture: parallel slots with their own not-found.tsx. Next.js attaches
 * a segment's not-found boundary to its `children`, so a slot's own file
 * catches the slot page's notFound() inside the slot, and the rest of the
 * route keeps rendering.
 */
export default function Layout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div id="slot-own-layout">
      <nav>
        <Link href={BASE}>Home</Link>
        <Link href={`${BASE}/team/ok`}>Team ok</Link>
        <Link href={`${BASE}/team/missing`}>Team missing</Link>
        <Link href={`${BASE}/team/missing/members`}>Members missing</Link>
        <Link href={`${BASE}/team/missing/roster`}>Roster missing</Link>
        <Link href={`${BASE}/team/ok/roster/player/ok`}>Player ok</Link>
        <Link href={`${BASE}/team/ok/roster/player/missing`}>Player missing</Link>
        <Link href={`${BASE}/item/ok`}>Item ok</Link>
        <Link href={`${BASE}/item/missing`}>Item missing</Link>
        <Link href={`${BASE}/item/meta-missing`}>Item metadata missing</Link>
        <Link href={`${BASE}/item/meta-forbidden`}>Item metadata forbidden</Link>
        <Link href={`${BASE}/item/meta-unauthorized`}>Item metadata unauthorized</Link>
        <Link href={`${BASE}/item/meta-error`}>Item metadata error</Link>
        <Link href={`${BASE}/team/both`}>Team both</Link>
        <Link href={`${BASE}/team/late`}>Team late</Link>
        <Link href={`${BASE}/panel`}>Panel default</Link>
        <Link href={`${BASE}/team/gone`}>Team gone</Link>
        <Link href={`${BASE}/tmpl`}>Template</Link>
      </nav>
      {children}
      <aside id="slot-own-modal">{modal}</aside>
    </div>
  );
}
