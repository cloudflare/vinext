import { getProduct, TOTAL_PRODUCTS } from "../../data";
import Link from "next/link";

export const revalidate = 3600; // ISR: revalidate every hour

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);

  if (isNaN(id) || id < 1 || id > TOTAL_PRODUCTS) {
    return (
      <div className="product-page">
        <Link href="/" className="back">
          &larr; Back to demo
        </Link>
        <h1>Product not found</h1>
      </div>
    );
  }

  const product = getProduct(id);
  const stars = "\u2605".repeat(Math.round(product.rating)) +
    "\u2606".repeat(5 - Math.round(product.rating));

  return (
    <div className="product-page">
      <Link href="/" className="back">
        &larr; Back to TPR demo
      </Link>

      <h1>{product.name}</h1>
      <span className="product-category">{product.category}</span>

      <div className="product-price">${product.price.toFixed(2)}</div>
      <p className="product-desc">{product.description}</p>

      <div className="product-meta">
        <div className="product-meta-item">
          <div className="meta-label">Rating</div>
          <div className="meta-value">{stars} {product.rating}</div>
        </div>
        <div className="product-meta-item">
          <div className="meta-label">Reviews</div>
          <div className="meta-value">{product.reviews.toLocaleString()}</div>
        </div>
        <div className="product-meta-item">
          <div className="meta-label">Product ID</div>
          <div className="meta-value">#{id}</div>
        </div>
      </div>
    </div>
  );
}
