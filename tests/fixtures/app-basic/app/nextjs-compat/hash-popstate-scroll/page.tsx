import Link from "next/link";

export default function HashPopstateScrollPage() {
  return (
    <main style={{ minHeight: "3200px", padding: 24 }}>
      <h1>Hash Popstate Scroll</h1>
      <nav style={{ display: "flex", gap: 16 }}>
        <Link href="#content" id="hash-link">
          Go to content
        </Link>
        <Link href="#caf%C3%A9" id="encoded-link">
          Go to cafe
        </Link>
        <Link href="#legacy-anchor" id="name-link">
          Go to named anchor
        </Link>
        <Link href="#top" id="top-link">
          Go to top
        </Link>
      </nav>
      <div style={{ height: 1200 }} />
      <section id="content" style={{ minHeight: 400 }}>
        <h2>Anchored Content</h2>
        <p>This content should be restored into view on forward traversal.</p>
      </section>
      <div style={{ height: 700 }} />
      <section id="café" style={{ minHeight: 400 }}>
        <h2>Encoded Cafe</h2>
        <p>This target requires decoding the URL hash fragment.</p>
      </section>
      <div style={{ height: 700 }} />
      <a name="legacy-anchor" style={{ display: "block", minHeight: 400 }}>
        <h2>Named Anchor</h2>
        <p>This target uses the browser-compatible name fallback.</p>
      </a>
    </main>
  );
}
