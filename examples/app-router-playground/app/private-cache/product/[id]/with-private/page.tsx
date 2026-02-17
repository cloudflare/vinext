import { Suspense } from 'react';
import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { ProductCard } from '#/ui/product-card';
import { cacheLife, cacheTag } from 'next/cache';
import { cookies } from 'next/headers';
import { getPersonalizedRecommendations } from '../../../_components/recommendations';
import { notFound } from 'next/navigation';
import { ProductDetails } from '#/app/private-cache/_components/product-detail';
import Link from 'next/link';
import { ChevronLeftIcon } from '@heroicons/react/24/solid';

// CRITICAL: This enables runtime prefetching!
export const unstable_prefetch = {
  mode: 'runtime',
  samples: [
    { params: { id: '1' }, cookies: [{ name: 'session-id', value: '1' }] },
  ],
};

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await db.product.find({ where: { id } });

  if (!product) {
    notFound();
  }

  return (
    <Boundary label="page.tsx (with-private)" animateRerendering={false}>
      <div className="flex flex-col gap-8">
        <Link
          href="/private-cache"
          className="flex items-center gap-2 font-medium text-gray-300 hover:text-white"
        >
          <ChevronLeftIcon className="size-6 text-gray-600" />
          <div>Shop</div>
        </Link>

        {/* Static Product Details */}
        <ProductDetails product={product} />

        {/* Private Cache - RUNTIME PREFETCHABLE! */}
        <Suspense fallback={<RecommendationsSkeleton />}>
          <Recommendations productId={id} />
        </Suspense>
      </div>
    </Boundary>
  );
}

async function Recommendations({ productId }: { productId: string }) {
  const recommendations = await getRecommendations(productId);

  return (
    <Boundary
      label="<Recommendations> (Private Cacheable + Runtime Prefetch)"
      size="small"
      animateRerendering={false}
    >
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-gray-300">Recommendations</h2>
        {recommendations.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-8 text-center">
            <p className="text-gray-500">No recommendations available</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {recommendations.map((rec) => (
              <ProductCard key={rec.id} product={rec} />
            ))}
          </div>
        )}
      </div>
    </Boundary>
  );
}

// Private cache - RUNTIME PREFETCHABLE!
async function getRecommendations(productId: string) {
  'use cache: private';
  cacheTag(`recommendations-${productId}`);
  cacheLife({ stale: 60 }); // 60s stale time (≥30s required for runtime prefetch)

  // Can call cookies() inside private cache!
  const sessionId = (await cookies()).get('session-id')?.value || 'guest';

  // Get personalized recommendations
  return getPersonalizedRecommendations(productId, sessionId);
}

function RecommendationsSkeleton() {
  return (
    <Boundary
      label="<Recommendations> (Private Cacheable + Runtime Prefetch)"
      size="small"
      color="blue"
      animateRerendering={false}
    >
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-gray-300">Recommendations</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
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
