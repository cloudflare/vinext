'use client';

import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/20/solid';
import { addTransitionType, startTransition, ViewTransition } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * Extended Link component that adds a type to a navigation transition.
 * Allows <ViewTransition> to set transition classes by type.
 *
 * @example
 * <TransitionLink href="/products/1" type="transition-backwards">
 *   View Product
 * </TransitionLink>
 */
export function TransitionLink({ type, ...props }: TransitionLinkProps) {
  const router = useRouter();

  const handleNavigate: TransitionLinkProps['onNavigate'] = (event) => {
    event.preventDefault();

    startTransition(() => {
      addTransitionType(type);
      router.push(props.href);
    });
  };

  return <Link onNavigate={handleNavigate} {...props} />;
}

/**
 * Button variant of TransitionLink with directional chevrons.
 *
 * @example
 * <TransitionButtonLink type="transition-backwards" href="/products">
 *   Back to Products
 * </TransitionButtonLink>
 */
export function TransitionButtonLink({
  type,
  children,
  className,
  ...props
}: TransitionLinkProps) {
  return (
    <TransitionLink
      type={type}
      className={clsx(
        'flex w-fit items-center gap-1 rounded-md bg-gray-700 px-3 py-1 text-sm font-medium text-gray-100 hover:bg-gray-500 hover:text-white',
        className,
        type === 'transition-backwards' && 'pl-1.5',
        type === 'transition-forwards' && 'pr-1.5',
      )}
      {...props}
    >
      {type === 'transition-backwards' && (
        <ChevronLeftIcon className="size-5 opacity-40" />
      )}
      {children}
      {type === 'transition-forwards' && (
        <ChevronRightIcon className="size-5 opacity-40" />
      )}
    </TransitionLink>
  );
}

/**
 * Wrapper for horizontal page transitions with type-safe props.
 *
 * @example
 * <HorizontalTransition
 *   enter={{ default: 'none', 'transition-to-detail': 'animate-slide-from-right' }}
 *   exit={{ default: 'none', 'transition-to-detail': 'animate-slide-to-left' }}
 * >
 *   <PageContent />
 * </HorizontalTransition>
 */
export function HorizontalTransition({
  children,
  enter,
  exit,
}: {
  children: React.ReactNode;
  enter: TransitionMap;
  exit: TransitionMap;
}) {
  return (
    <ViewTransition enter={enter} exit={exit}>
      {children}
    </ViewTransition>
  );
}

/**
 * Wrapper for shared element transitions between views.
 * Enables morphing of elements that persistacross transitions.
 *
 * @example
 * <SharedTransition name="product-image" share="animate-morph">
 *   <ProductImage src={image} alt={name} />
 * </SharedTransition>
 */
export function SharedTransition({
  name,
  children,
  share,
}: {
  name: TransitionId;
  children: React.ReactNode;
  share?: ViewTransitionClass;
}) {
  return (
    <ViewTransition name={name} share={share}>
      {children}
    </ViewTransition>
  );
}

/**
 * Type-safe transition options to prevent ID clashes and props
 * in TransitionLinks and ViewTransitions from drifting apart.
 */

/**
 * Available transition IDs for shared elements
 * @internal
 */
const transitionIds = [
  'navigation-icon',
  'navigation-title',
  'navigation-pagination',
] as const;

/**
 * Available transition types for navigation
 * @internal
 */
const transitionTypes = [
  'default',
  'transition-to-detail',
  'transition-to-list',
  'transition-backwards',
  'transition-forwards',
] as const;

/**
 * Available animation types for transitions
 * @internal
 */
const animationTypes = [
  'auto',
  'none',
  'animate-slide-from-left',
  'animate-slide-from-right',
  'animate-slide-to-left',
  'animate-slide-to-right',
  'animate-morph',
] as const;

/**
 * Type for transition types with their corresponding animations
 */
type TransitionType = (typeof transitionTypes)[number];

/**
 * Type for available animation classes
 */
type AnimationType = (typeof animationTypes)[number];

/**
 * Mapping of transition types to their animation classes
 * @example
 * const transitions: TransitionMap = {
 *   default: 'none',
 *   'transition-to-detail': 'animate-slide-from-right',
 *   'transition-to-list': 'animate-slide-from-left'
 * }
 */
type TransitionMap = { default: AnimationType } & Partial<
  Record<Exclude<TransitionType, 'default'>, AnimationType>
>;

/**
 * Type for transition class names or transition maps
 * <ViewTransition> props accept both.
 */
type ViewTransitionClass = AnimationType | TransitionMap;

/**
 * Type for transition element IDs
 */
type TransitionId = (typeof transitionIds)[number] | `product-${string}`;

/**
 * Props for TransitionLink component
 * Extends Next.js Link props with transition type
 */
type TransitionLinkProps = Omit<React.ComponentProps<typeof Link>, 'href'> & {
  type: TransitionType;
  /**
   * Target URL for navigation
   * Overwite Next's href that can also be an object
   */
  href: string;
};
