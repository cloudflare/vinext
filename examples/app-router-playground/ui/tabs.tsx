'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Suspense } from 'react';

export type Item = { text: string; slug?: string; segment?: string };

export function Tabs({ basePath, items }: { basePath: string; items: Item[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((item) => (
        <Tab key={basePath + item.slug} item={item} basePath={basePath} />
      ))}
    </div>
  );
}

export function Tab({
  basePath = '',
  item,
}: {
  basePath?: string;
  item: Item;
}) {
  const href = item.slug ? `${basePath}/${item.slug}` : basePath;

  return (
    <Link href={href} className="text-sm font-semibold">
      {/*
       * `useSelectedLayoutSegment` suspends, so we place a Suspense boundary
       * as deep as possible to allow the route's fallback shell to include
       * these elements
       */}
      <Suspense fallback={<TabContent>{item.text}</TabContent>}>
        <DynamicTabContent href={href}>{item.text}</DynamicTabContent>
      </Suspense>
    </Link>
  );
}

// Note: We create an additional component because useLinkStatus should be
// called from a component that is rendered inside a `<Link>`
function DynamicTabContent({
  children,
  href,
}: {
  children: React.ReactNode;
  href: string;
}) {
  const pathname = usePathname();
  const isActive = pathname === href;
  const { pending: isPending } = useLinkStatus();

  return (
    <TabContent isActive={isActive} isPending={isPending}>
      {children}
    </TabContent>
  );
}

function TabContent({
  children,
  isActive,
  isPending,
}: {
  children: React.ReactNode;
  isActive?: boolean;
  isPending?: boolean;
}) {
  return (
    <span
      className={clsx('flex rounded-md px-3 py-1 transition duration-75', {
        'bg-gray-700 text-gray-100 hover:bg-gray-500 hover:text-white':
          !isActive && !isPending,
        'bg-blue-600 text-white': isActive,
        'bg-gray-800 text-gray-500 delay-75': isPending,
      })}
    >
      {children}
    </span>
  );
}
