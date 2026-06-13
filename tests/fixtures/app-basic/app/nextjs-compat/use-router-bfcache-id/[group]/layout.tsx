"use client";

import { useRouter } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { LinkAccordion } from "../components/link-accordion";

const base = "/nextjs-compat/use-router-bfcache-id";

export default function GroupLayout({ children }: { children: ReactNode }) {
  const { bfcacheId } = useRouter();

  return (
    <section>
      <nav>
        <LinkAccordion href={`${base}/x/1`}>/x/1</LinkAccordion>
        <LinkAccordion href={`${base}/x/2`}>/x/2</LinkAccordion>
        <LinkAccordion href={`${base}/y/1`}>/y/1</LinkAccordion>
      </nav>
      <p data-testid="layout-bfcache-id">{bfcacheId}</p>
      <form key={bfcacheId}>
        <input data-testid="layout-input" defaultValue="" />
      </form>
      <Suspense fallback={null}>{children}</Suspense>
    </section>
  );
}
