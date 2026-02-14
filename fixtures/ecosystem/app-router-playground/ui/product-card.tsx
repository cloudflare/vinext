import { Product } from '#/lib/db';
import clsx from 'clsx';
import Image from 'next/image';

import {
  ElementType,
  ComponentPropsWithoutRef,
  PropsWithChildren,
} from 'react';

export type PolymorphicProps<
  E extends ElementType,
  P = {},
> = PropsWithChildren<P> & { as?: E } & Omit<
    ComponentPropsWithoutRef<E>,
    keyof P | 'as' | 'children'
  >;

type ProductCardProps<E extends ElementType> = PolymorphicProps<
  E,
  { product: Product; animateEnter?: boolean }
>;

export function ProductCard<E extends ElementType = 'div'>({
  as,
  product,
  animateEnter,
  ...rest
}: ProductCardProps<E>) {
  const Component = as || 'div';
  return (
    <Component className="group flex flex-col gap-2.5" {...rest}>
      <div className="overflow-hidden rounded-md bg-gray-900/50 p-8 group-hover:bg-gray-900">
        <Image
          className={clsx(animateEnter && 'transition-enter')}
          src={`/shop/${product.image}`}
          alt={product.name}
          quality={90}
          width={400}
          height={400}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="h-2 w-4/5 rounded-full bg-gray-800" />
        <div className="h-2 w-1/3 rounded-full bg-gray-800" />
      </div>
    </Component>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="group flex flex-col gap-2.5">
      <div
        className={clsx(
          'aspect-square overflow-hidden rounded-md bg-gray-900/50',
          'relative before:absolute before:inset-0',
          'before:bg-gradient-to-r before:from-transparent before:via-white/5 before:to-transparent',
          'before:translate-x-[-50%] before:opacity-0',
          'before:animate-shimmer',
        )}
      />

      <div className="flex flex-col gap-2">
        <div className="h-2 w-4/5 rounded-full bg-gray-800" />
        <div className="h-2 w-1/3 rounded-full bg-gray-800" />
      </div>
    </div>
  );
}

export function ProductList({
  children,
  title,
  count,
}: {
  children: React.ReactNode;
  title: string;
  count: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="flex items-center gap-2 text-xl font-medium text-gray-300">
        <div>{title}</div>
        <span className="font-mono tracking-tighter text-gray-600">
          ({count})
        </span>
      </h1>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">{children}</div>
    </div>
  );
}

export function ProductListSkeleton({
  title,
  count = 3,
}: {
  title: string;
  count?: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-medium text-gray-600">{title}</h1>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {Array.from({ length: count }).map((_, i) => (
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
