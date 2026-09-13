import Link from "next/link";
import { catalog } from "../lib/content";

// Make the build-time contract explicit: request-time APIs used below would
// be an error rather than silently changing this page into SSR.
export const dynamic = "error";

const capabilities = [
  ["Build-time React", "Server Components run during vinext build and become durable HTML plus static RSC payloads."],
  ["Known dynamic paths", "generateStaticParams expands dynamic and catch-all routes before anything is deployed."],
  ["Browser interactivity", "Client Components hydrate normally, including state, effects, and query-string navigation."],
  ["Both routers", "App Router generation and Pages Router SSG can coexist in one exported application."],
] as const;

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div>
          <p className="kicker">A complete vinext static export</p>
          <h1>Build the experience.<br /><em>Leave the server.</em></h1>
          <p className="lede">
            This site is an App Router and Pages Router application rendered ahead of time, then
            deployed as an assets-only site. Every linked content route exists before the first request.
          </p>
          <div className="actions">
            <Link className="button primary" href="/catalog/pocket-observatory">Explore generated pages</Link>
            <Link className="button" href="/docs/deployment/cloudflare">See the deploy model</Link>
          </div>
        </div>
        <div className="artifact-card">
          <img src="/island-grid.svg" alt="An abstract island drawn as a contour map" width={640} height={480} />
          <dl>
            <div><dt>Runtime requests</dt><dd>0</dd></div>
            <div><dt>Deploy directory</dt><dd>dist/client</dd></div>
            <div><dt>Worker code</dt><dd>none</dd></div>
          </dl>
        </div>
      </section>

      <section className="section-block" aria-labelledby="capabilities-title">
        <p className="kicker">What this example proves</p>
        <h2 id="capabilities-title">Static does not mean inert.</h2>
        <div className="feature-grid">
          {capabilities.map(([title, copy], index) => (
            <article className="feature" key={title}>
              <span className="feature-number">0{index + 1}</span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-block split" aria-labelledby="catalog-title">
        <div>
          <p className="kicker">generateStaticParams</p>
          <h2 id="catalog-title">Three slugs. Three real documents.</h2>
          <p className="section-copy">The dynamic route template never reaches production. Its known parameter values become concrete HTML files during the build.</p>
        </div>
        <div className="catalog-list">
          {catalog.map((item) => (
            <Link href={`/catalog/${item.slug}`} key={item.slug}>
              <span>{item.name}</span><span aria-hidden="true">↗</span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
