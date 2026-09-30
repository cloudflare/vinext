import Link from "next/link";

export default function CommitRaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <nav>
        <Link
          href="/commit-race/layout-navigation"
          prefetch={false}
          data-testid="link-layout-navigation"
        >
          Layout navigation
        </Link>
        <Link href="/commit-race/start#top" prefetch={false} data-testid="link-start-hash">
          Start hash
        </Link>
        <Link href="/commit-race/group/a" prefetch={false} data-testid="link-group-a">
          Group A
        </Link>
        {" | "}
        <Link href="/commit-race/group/b" prefetch={false} data-testid="link-group-b">
          Group B
        </Link>
      </nav>
      {children}
    </main>
  );
}
