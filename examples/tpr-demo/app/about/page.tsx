import Link from "next/link";

export default function About() {
  return (
    <div className="product-page">
      <Link href="/" className="back">
        &larr; Back to TPR demo
      </Link>
      <h1>About</h1>
      <p className="product-desc">
        This is a demo e-commerce site with 500 product pages, built to
        demonstrate Traffic-aware Pre-Warming (TPR). Each product page
        uses ISR with a 1-hour revalidation window.
      </p>
      <p className="product-desc">
        When deployed with <code>npx @vinext/cloudflare deploy --experimental-tpr</code>, TPR
        queries Cloudflare zone analytics to determine which product pages
        actually get traffic, then sends only those routes through vinext's
        standard CDN pre-warmer. The rest are rendered and cached on demand.
      </p>
    </div>
  );
}
