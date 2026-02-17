import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { ProductCard } from '#/ui/product-card';
import { cacheTag } from 'next/cache';
import Link from 'next/link';
import SessionButton from './session-button';
import ProductLink from './product-link';

export async function ProductList() {
  const products = await getProducts();

  return (
    <Boundary
      label="<ProductList> (statically inferred)"
      size="small"
      animateRerendering={false}
    >
      <div className="flex flex-col gap-4">
        <div className="flex justify-between">
          <h1 className="text-xl font-semibold text-gray-300">
            Available Products{' '}
            <span className="font-mono tracking-tighter text-gray-600">
              ({products.length})
            </span>
          </h1>

          <div className="flex">
            <SessionButton />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {products.map((product, index) => {
            // First half uses private cache (with runtime prefetch)
            // Second half uses remote cache (no prefetch)
            const privateCache = index < products.length / 2;

            return (
              <ProductLink
                href={
                  privateCache
                    ? `/private-cache/product/${product.id}/with-private`
                    : `/private-cache/product/${product.id}/without-private`
                }
                privateCache={privateCache}
                key={product.id}
              >
                <ProductCard product={product} animateEnter={true} />
              </ProductLink>
            );
          })}
        </div>
      </div>
    </Boundary>
  );
}

export function ProductListSkeleton() {
  return (
    <Boundary
      label="<ProductList> (statically inferred)"
      size="small"
      color="blue"
      animateRerendering={false}
    >
      <div className="flex flex-col gap-4">
        <div className="h-24 animate-pulse rounded-lg bg-gray-800" />
        <h1 className="text-xl font-semibold text-gray-300">
          Available Products
        </h1>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-lg bg-gray-800"
            />
          ))}
        </div>
      </div>
    </Boundary>
  );
}

async function getProducts() {
  'use cache';
  cacheTag('products');

  // DEMO: Add a delay to simulate a slow data request
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const products = await db.product.findMany({ limit: 4 });

  // Tag each product for targeted invalidation
  for (const product of products) {
    cacheTag(`product-${product.id}`);
  }

  return products;
}
