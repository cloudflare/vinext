import Link from "next/link";

export default function ParallelLayoutsLayout({
  children,
  foo,
  bar,
}: {
  children: React.ReactNode;
  foo: React.ReactNode;
  bar: React.ReactNode;
}) {
  return (
    <main>
      <Link href="/parallel-layouts/subroute" data-testid="parallel-layouts-subroute-link">
        Subroute
      </Link>
      <Link href="/parallel-layouts/settings" data-testid="parallel-layouts-settings-link">
        Settings
      </Link>
      <Link href="/parallel-layouts/modal" data-testid="parallel-layouts-modal-link">
        Modal
      </Link>
      <div data-testid="parallel-layouts-children">{children}</div>
      <div>{foo}</div>
      <div>{bar}</div>
    </main>
  );
}
