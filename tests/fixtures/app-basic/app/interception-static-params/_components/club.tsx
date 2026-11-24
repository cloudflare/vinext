import Link from "next/link";
import type { ReactNode } from "react";

export function ClubLayout({
  base,
  children,
  modal,
  slug,
}: {
  base: string;
  children: ReactNode;
  modal: ReactNode;
  slug: string;
}) {
  return (
    <div>
      <p data-testid="club-layout">
        {base} layout: {slug}
      </p>
      <div data-testid="club-children">{children}</div>
      <div data-testid="club-modal">{modal}</div>
    </div>
  );
}

export function ClubLinks({ base, slug }: { base: string; slug: string }) {
  const href = (path: string) => `/interception-static-params/${base}/club/${path}`;
  return (
    <nav>
      <p data-testid="club-page">Club page: {slug}</p>
      <Link href={href(`${slug}/pics/1`)}>Pics 1</Link>
      <Link href={href(`${slug}/pics/2`)}>Pics 2</Link>
      <Link href={href(`${slug}/photo/1`)}>Photo 1</Link>
      <Link href={href(`${slug}/photo/2`)}>Photo 2</Link>
      <Link href={href(`${slug}/info/1`)}>Info 1</Link>
      <Link href={href(`${slug}/pics/1/details`)}>Details 1</Link>
      <Link href={href(`${slug}/pics/2/details`)}>Details 2</Link>
      <Link href={href("acme/pics/1")}>Acme pics 1</Link>
      <Link href={href("acme/info/1")}>Acme info 1</Link>
    </nav>
  );
}

export type ClubParams = Promise<{ slug: string }>;
export type ItemParams = Promise<{ slug: string; id: string }>;

export async function ItemModal({ kind, params }: { kind: string; params: ItemParams }) {
  const { slug, id } = await params;
  return (
    <p data-testid="item-modal">
      {kind} modal: {slug} {id}
    </p>
  );
}

export async function ItemPage({ kind, params }: { kind: string; params: ItemParams }) {
  const { slug, id } = await params;
  return (
    <p data-testid="item-page">
      {kind} page: {slug} {id}
    </p>
  );
}
