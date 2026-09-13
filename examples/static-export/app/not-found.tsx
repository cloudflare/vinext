import Link from "next/link";

export default function NotFound() {
  return (
    <section className="not-found">
      <p className="kicker">404 · generated at build time</p>
      <h1>This route was never in the map.</h1>
      <p>The static host is serving vinext&apos;s exported 404 document.</p>
      <Link className="button primary" href="/">Return to the overview</Link>
    </section>
  );
}
