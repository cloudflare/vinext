import Link from "next/link";

export default function FontNavigationAPage() {
  return (
    <>
      <h1 data-testid="font-navigation-a">Font navigation A</h1>
      <Link href="/font-navigation/b" data-testid="font-navigation-link">
        To B
      </Link>
    </>
  );
}
