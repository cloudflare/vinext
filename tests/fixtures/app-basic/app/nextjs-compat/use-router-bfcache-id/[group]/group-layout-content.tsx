"use client";

import { useParams, usePathname, useRouter } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { LinkAccordion } from "../components/link-accordion";

const base = "/nextjs-compat/use-router-bfcache-id";

export function GroupLayoutContent({
  children,
  serverGroup,
}: {
  children: ReactNode;
  serverGroup: string;
}) {
  const params = useParams();
  const pathname = usePathname();
  const { bfcacheId } = useRouter();
  const groupParam = params.group;
  const group = Array.isArray(groupParam) ? groupParam.join("/") : (groupParam ?? "");

  return (
    <section>
      <nav>
        <LinkAccordion href={`${base}/x/1`}>/x/1</LinkAccordion>
        <LinkAccordion href={`${base}/x/2`}>/x/2</LinkAccordion>
        <LinkAccordion href={`${base}/y/1`}>/y/1</LinkAccordion>
      </nav>
      <p data-testid="server-group">{serverGroup}</p>
      <p data-testid="layout-pathname">{pathname}</p>
      <p data-testid="layout-param-group">{group}</p>
      <p data-testid="layout-bfcache-id">{bfcacheId}</p>
      <form key={bfcacheId}>
        <input data-testid="layout-input" defaultValue="" />
      </form>
      <Suspense fallback={null}>{children}</Suspense>
    </section>
  );
}
