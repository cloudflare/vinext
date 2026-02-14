export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Product ${id}` };
}
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <h1>Product {id}</h1>
      <p>This is the detail page for product {id}. Rendered at {new Date().toISOString()}</p>
    </div>
  );
}

