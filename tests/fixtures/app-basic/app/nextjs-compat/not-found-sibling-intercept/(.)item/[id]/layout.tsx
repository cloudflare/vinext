import { notFound } from "next/navigation";

export default async function InterceptItemLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // This layout's own signal skips the not-found.tsx inside it. With no
  // not-found above it in the intercepting route, the source's catches it.
  if (id === "layout-missing") notFound();
  return <div id="not-found-sibling-intercept-item-layout">{children}</div>;
}
