import type { ReactNode } from "react";
import { NoInline } from "../../../components/no-inline";

export const prefetchSize = "large";

export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div>
      <NoInline />
      <p>{`Dynamic layout for: ${slug}`}</p>
      {children}
    </div>
  );
}
