import type { ReactNode } from "react";
import { GroupLayoutContent } from "./group-layout-content";

export default async function GroupLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ group: string }>;
}) {
  const { group } = await params;
  return <GroupLayoutContent serverGroup={group}>{children}</GroupLayoutContent>;
}
