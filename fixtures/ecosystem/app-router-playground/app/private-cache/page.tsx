import { Suspense } from 'react';
import { ProductList, ProductListSkeleton } from './_components/product-list';
import { Boundary } from '#/ui/boundary';

export default function Page() {
  return (
    <Boundary label="page.tsx (statically inferred)" animateRerendering={false}>
      <div className="flex flex-col gap-8">
        <Suspense fallback={<ProductListSkeleton />}>
          <ProductList />
        </Suspense>
      </div>
    </Boundary>
  );
}
