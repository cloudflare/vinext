// Only allow statically known product IDs
export const dynamicParams = false;

export async function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }, { id: "3" }];
}

export default function ProductPage({ params }: { params: { id: string } }) {
  return (
    <div data-testid="product-page">
      <h1>Product {params.id}</h1>
      <p>This product page only works for IDs 1, 2, and 3.</p>
    </div>
  );
}
