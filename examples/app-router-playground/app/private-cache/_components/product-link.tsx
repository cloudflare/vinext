'use client';

import { Boundary } from '#/ui/boundary';
import Link from 'next/link';
import { useSyncExternalStore } from 'react';

// DEMO: State tracking for runtime prefetch visualization. This Map and Set
// are used to track prefetch loading states and notify components when the
// state changes, enabling the visual feedback (pink pulsing border while
// prefetching, blue border when complete) shown in this demo.
const loadingState = new Map<string, 'prefetching' | 'prefetched'>();
const subscribers = new Set<() => void>();

function notifySubscribers() {
  subscribers.forEach((callback) => callback());
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

// DEMO: Fetch patching for visualization purposes only. This code intercepts
// Next.js runtime prefetch requests to track their loading states and provide
// visual feedback in the UI. DO NOT use this pattern in production apps - it's
// solely for demonstrating how runtime prefetching works with private cache.
if (typeof window !== 'undefined') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args: Parameters<typeof fetch>) => {
    // Ensure that we only monitor runtime prefetch requests.
    if (
      args[0] instanceof URL &&
      (args[1]?.headers as Record<string, string>)?.['next-router-prefetch'] ===
        '2'
    ) {
      const url = args[0];
      console.log('Monitoring fetch for', url.pathname);
      const promise = originalFetch(url, args[1]);

      loadingState.set(url.pathname, 'prefetching');
      notifySubscribers();

      promise.then(() => {
        loadingState.set(url.pathname, 'prefetched');
        notifySubscribers();
      });

      return promise;
    }

    return originalFetch(...args);
  };

  console.log('Fetch patched');
}

function getSnapshot(pathname: string): 'prefetching' | 'prefetched' | 'idle' {
  return loadingState.get(pathname) ?? 'idle';
}

export default function ProductLink({
  children,
  href,
  privateCache = false,
}: {
  children: React.ReactNode;
  href: string;
  privateCache: boolean;
}) {
  // Extract pathname from href
  const pathname = href.startsWith('/') ? href : new URL(href).pathname;

  // Subscribe to loading state changes
  const state = useSyncExternalStore(
    subscribe,
    () => getSnapshot(pathname),
    () => 'idle',
  );

  // Determine color and label based on loading state
  let color: 'pink' | 'blue' | undefined;
  let label: string;

  if (state !== 'prefetched' && privateCache) {
    color = 'pink';
    label = '<Link> (Prefetching Private Cache...)';
  } else if (state === 'prefetched') {
    color = 'blue';
    label = '<Link> (Prefetched Private Cache)';
  } else {
    label = `<Link> (No Private Cache)`;
  }

  return (
    <Link href={href}>
      <Boundary
        label={label}
        size="small"
        color={color}
        animateRerendering={false}
        pulse={state === 'prefetching'}
      >
        {children}
      </Boundary>
    </Link>
  );
}
