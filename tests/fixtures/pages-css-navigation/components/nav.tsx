import Link from "next/link";

export const PAGES = [
  "alpha",
  "beta",
  "plain",
  "bare",
  "dynamic",
  "ledger",
  "gamma",
  "delta",
  "ordered",
  "reversed",
  "epsilon",
  "note",
  "later",
  "host",
] as const;

export function Nav() {
  return (
    <nav>
      {PAGES.map((page) => (
        <Link key={page} href={`/${page}`} data-testid={`nav-${page}`}>
          {page}
        </Link>
      ))}
    </nav>
  );
}
