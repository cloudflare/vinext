import Link from "next/link";

export default function Contact() {
  return (
    <div className="product-page">
      <Link href="/" className="back">
        &larr; Back to TPR demo
      </Link>
      <h1>Contact</h1>
      <p className="product-desc">
        This is a static page in the TPR demo. Static pages like this one
        are always pre-rendered because they consistently appear in the top
        traffic data.
      </p>
      <p className="product-desc">
        In a real application, this would contain a contact form or support
        information. For the purposes of this demo, it demonstrates that
        TPR correctly identifies and pre-renders high-traffic static pages
        alongside dynamic product pages.
      </p>
    </div>
  );
}
