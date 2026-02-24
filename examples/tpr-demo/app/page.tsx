import TPRVisualization from "./components/tpr-visualization";

export default function Home() {
  return (
    <main>
      <nav>
        <div className="nav-inner">
          <div className="nav-brand">vinext / TPR demo</div>
          <div className="nav-links">
            <a href="#trade-off">Trade-off</a>
            <a href="#power-law">Power law</a>
            <a href="#comparison">Comparison</a>
            <a href="/products/1">Sample product</a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero" style={{ borderBottom: "none" }}>
        <div className="container">
          <div className="badge">vinext</div>
          <h1>
            Traffic-aware
            <br />
            Pre-Rendering
          </h1>
          <p>
            SSG makes you guess which pages matter. TPR knows. It queries
            Cloudflare zone analytics at deploy time, pre-renders only the
            pages that cover 90% of your traffic, and caches them in KV.
          </p>
        </div>
      </section>

      <TPRVisualization />

      {/* Footer */}
      <footer
        style={{
          padding: "40px 24px",
          textAlign: "center",
          color: "var(--muted)",
          fontSize: "0.85rem",
        }}
      >
        Built with{" "}
        <a
          href="https://github.com/cloudflare/vinext"
          style={{ color: "var(--accent)" }}
        >
          vinext
        </a>{" "}
        — Next.js apps on Vite, deployed to Cloudflare Workers.
      </footer>
    </main>
  );
}
