"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type RouterAutoscrollControls = {
  push: (href: string) => void;
  pushNoScroll: (href: string) => void;
};

declare global {
  interface Window {
    __vinextRouterAutoscroll?: RouterAutoscrollControls;
  }
}

export function RouterAutoscrollControls() {
  const router = useRouter();

  useEffect(() => {
    const controls: RouterAutoscrollControls = {
      push: (href) => router.push(href),
      pushNoScroll: (href) => router.push(href, { scroll: false }),
    };
    window.__vinextRouterAutoscroll = controls;

    return () => {
      if (window.__vinextRouterAutoscroll === controls) {
        delete window.__vinextRouterAutoscroll;
      }
    };
  }, [router]);

  return null;
}
