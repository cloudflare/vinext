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
        demonstrate Traffic-aware Pre-Rendering (TPR). Each product page
        uses ISR with a 1-hour revalidation window.
      </p>
      <p className="product-desc">
        When deployed with <code>vinext deploy --experimental-tpr</code>, TPR
        queries Cloudflare zone analytics to determine which product pages
        actually get traffic, and pre-renders only those into KV cache. The
        rest are rendered on demand via SSR and cached for subsequent requests.
      </p>
    </div>
  );
}
