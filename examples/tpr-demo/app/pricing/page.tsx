import Link from "next/link";

export default function Pricing() {
  return (
    <div className="product-page">
      <Link href="/" className="back">
        &larr; Back to TPR demo
      </Link>
      <h1>Pricing</h1>
      <p className="product-desc">
        This is a static page in the TPR demo. Static pages like this one
        are always pre-rendered because they consistently appear in the top
        traffic data.
      </p>
    </div>
  );
}
