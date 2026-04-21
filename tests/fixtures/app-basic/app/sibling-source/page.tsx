import Link from "next/link";

export default function SiblingSourcePage() {
  return (
    <main data-testid="sibling-source-page">
      <h1>Sibling Source</h1>
      <Link href="/sibling-target/42" id="sibling-target-42-link">
        Open Target 42
      </Link>
    </main>
  );
}
