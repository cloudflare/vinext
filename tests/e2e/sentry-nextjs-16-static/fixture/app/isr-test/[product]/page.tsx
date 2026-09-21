export const revalidate = 60; // ISR: revalidate every 60 seconds
export const dynamicParams = true; // Allow dynamic params beyond generateStaticParams

export async function generateStaticParams(): Promise<Array<{ product: string }>> {
  return [{ product: 'laptop' }, { product: 'phone' }, { product: 'tablet' }];
}

export default async function ISRProductPage({ params }: { params: Promise<{ product: string }> }) {
  const { product } = await params;

  return (
    <div>
      <h1>ISR Product: {product}</h1>
      <div id="isr-product-id">{product}</div>
    </div>
  );
}
