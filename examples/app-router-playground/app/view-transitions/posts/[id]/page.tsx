'use cache';

import db from '#/lib/db';
import {
  HorizontalTransition,
  SharedTransition,
  TransitionButtonLink,
  TransitionLink,
} from '#/app/view-transitions/_ui/transitions';
import { Boundary } from '#/ui/boundary';
import { SkeletonText } from '#/ui/skeleton';
import { ChevronLeftIcon } from '@heroicons/react/24/solid';
import Image from 'next/image';
import { notFound } from 'next/navigation';

export async function generateStaticParams() {
  const products = db.product.findMany();

  return products.map((product) => ({ id: product.id }));
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = db.product.find({ where: { id } });
  if (!product) {
    notFound();
  }

  const demo = db.demo.find({ where: { slug: 'view-transitions' } });
  const prevProduct = `/${demo.slug}/posts/${product.prev}`;
  const nextProduct = `/${demo.slug}/posts/${product.next}`;

  return (
    <HorizontalTransition
      enter={{
        default: 'none',
        'transition-to-list': 'animate-slide-from-left',
        'transition-to-detail': 'animate-slide-from-right',
        'transition-backwards': 'animate-slide-from-left',
        'transition-forwards': 'animate-slide-from-right',
      }}
      exit={{
        default: 'none',
        'transition-to-list': 'animate-slide-to-right',
        'transition-to-detail': 'animate-slide-to-left',
        'transition-backwards': 'animate-slide-to-right',
        'transition-forwards': 'animate-slide-to-left',
      }}
    >
      <Boundary label="posts/[id]/page.tsx" animateRerendering={true}>
        <div className="grid gap-4">
          <TransitionLink
            href={`/${demo.slug}`}
            type="transition-to-list"
            className="flex items-center gap-2 font-medium text-gray-300 hover:text-white"
          >
            <SharedTransition
              name="navigation-icon"
              share={{
                default: 'auto',
                'transition-to-list': 'animate-morph',
                'transition-to-detail': 'animate-morph',
              }}
            >
              <ChevronLeftIcon className="size-6 text-gray-600" />
            </SharedTransition>

            <SharedTransition
              name="navigation-title"
              share={{
                default: 'auto',
                'transition-to-list': 'animate-morph',
                'transition-to-detail': 'animate-morph',
              }}
            >
              <div>Shop</div>
            </SharedTransition>
          </TransitionLink>

          <div className="grid grid-cols-2 gap-8">
            <SharedTransition
              name={`product-${product.id}`}
              share={{
                default: 'auto',
                'transition-to-list': 'animate-morph',
                'transition-to-detail': 'animate-morph',
              }}
            >
              <ProductImage src={product.image} alt={product.name} />
            </SharedTransition>

            <ProductDetails id={product.id} />
          </div>

          <SharedTransition name="navigation-pagination">
            <div className="flex justify-between gap-4">
              <TransitionButtonLink
                href={prevProduct}
                type="transition-backwards"
              >
                Previous
              </TransitionButtonLink>
              <TransitionButtonLink
                href={nextProduct}
                type="transition-forwards"
              >
                Next
              </TransitionButtonLink>
            </div>
          </SharedTransition>
        </div>
      </Boundary>
    </HorizontalTransition>
  );
}

function ProductDetails({ id: seed }: { id: string }) {
  return (
    <div className="flex w-4/5 flex-col gap-[1.4em] text-sm text-gray-800">
      <SkeletonText count={1} minLength={3} maxLength={12} seed={seed} />
      <SkeletonText count={2} minLength={26} maxLength={50} seed={seed} />
      <SkeletonText count={1} minLength={12} maxLength={18} seed={seed} />
    </div>
  );
}

function ProductImage({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="overflow-hidden rounded-md bg-gray-900/50 p-12">
      <Image
        className="brightness-150"
        src={`/shop/${src}`}
        alt={alt}
        quality={90}
        width={400}
        height={400}
      />
    </div>
  );
}
