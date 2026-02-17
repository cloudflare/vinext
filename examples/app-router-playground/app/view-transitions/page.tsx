'use cache';

import db from '#/lib/db';
import {
  TransitionLink,
  HorizontalTransition,
  SharedTransition,
} from '#/app/view-transitions/_ui/transitions';
import { Boundary } from '#/ui/boundary';
import Image from 'next/image';

export default async function Page() {
  const products = db.product.findMany();

  return (
    <HorizontalTransition
      enter={{
        default: 'none',
        'transition-to-list': 'animate-slide-from-left',
        'transition-to-detail': 'animate-slide-from-right',
      }}
      exit={{
        default: 'none',
        'transition-to-list': 'animate-slide-to-right',
        'transition-to-detail': 'animate-slide-to-left',
      }}
    >
      <Boundary label="page.tsx" animateRerendering={true}>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-xl font-medium text-gray-300">
            <SharedTransition name="navigation-title" share="animate-morph">
              <h1>Shop</h1>
            </SharedTransition>
            <span className="font-mono tracking-tighter text-gray-600">
              ({products.length})
            </span>
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {products.map((product) => (
              <TransitionLink
                key={product.id}
                href={`/view-transitions/posts/${product.id}`}
                type="transition-to-detail"
                className="group flex flex-col gap-2.5"
              >
                <SharedTransition
                  name={`product-${product.id}`}
                  share={{
                    default: 'auto',
                    'transition-to-list': 'animate-morph',
                    'transition-to-detail': 'animate-morph',
                  }}
                >
                  <div className="overflow-hidden rounded-md bg-gray-900/50 p-8 group-hover:bg-gray-900">
                    <Image
                      className="brightness-150"
                      src={`/shop/${product.image}`}
                      alt={product.name}
                      quality={90}
                      width={400}
                      height={400}
                    />
                  </div>
                </SharedTransition>

                <div className="flex flex-col gap-2">
                  <div className="h-2 w-4/5 rounded-full bg-gray-800" />
                  <div className="h-2 w-1/3 rounded-full bg-gray-800" />
                </div>
              </TransitionLink>
            ))}
          </div>
        </div>
      </Boundary>
    </HorizontalTransition>
  );
}
