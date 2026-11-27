import Link from "next/link";
import { AsideSegment } from "./aside-segment";

const BASE = "/parallel-slot-owner-params";

/**
 * Test fixture: a dynamic layout whose @aside slot renders its default for
 * every URL but /[id]/stats. A navigation that keeps the layout's params keeps
 * what the slot shows; one that changes them renders the slot's default for the
 * new params, as Next.js does.
 */
export default async function Layout({
  aside,
  children,
  params,
}: {
  aside: React.ReactNode;
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div>
      <p data-testid="owner-params-layout">layout {id}</p>
      <nav>
        <Link href={`${BASE}/1`}>One</Link>
        <Link href={`${BASE}/1/info`}>One info</Link>
        <Link href={`${BASE}/1/stats`}>One stats</Link>
        <Link href={`${BASE}/2`}>Two</Link>
        <Link href={`${BASE}/2/info`}>Two info</Link>
      </nav>
      <AsideSegment />
      <aside data-testid="owner-params-aside">{aside}</aside>
      <main data-testid="owner-params-children">{children}</main>
    </div>
  );
}
