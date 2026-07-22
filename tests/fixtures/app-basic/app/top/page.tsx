import Link from "next/link";

export default function TopPage() {
  return (
    <main data-testid="top-page">
      <h1>Top 1000</h1>
      <Link href="/film/tt0068646-the-godfather-1972" id="godfather-film-link">
        The Godfather
      </Link>
    </main>
  );
}
