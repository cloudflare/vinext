import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { ProductCard, ProductList } from '#/ui/product-card';
import Link from 'next/link';

export default function Page() {
  const products = db.product.findMany({ limit: 6 });

  return (
    <Boundary label="page.tsx" size="small" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold text-gray-200">
          Product gallery with modal interception
        </h1>
        <p className="max-w-2xl text-sm text-gray-400">
          This route stays visible while the target URL updates to a nested detail
          page. A direct load of the same URL renders the standalone detail page.
        </p>
      </div>

      <ProductList title="Products" count={products.length}>
        {products.map((product) => (
          <Link key={product.id} href={`/intercepting-routes/photo/${product.id}`}>
            <ProductCard
              product={product}
              className="rounded-xl border border-transparent p-2 transition hover:border-gray-800"
            />
          </Link>
        ))}
      </ProductList>
    </Boundary>
  );
}
