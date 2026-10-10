import { LayoutShell } from "./layout-shell";

export default async function LayoutSearchParamsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <LayoutShell>
      {children}
      <div id="layout-param">{id}</div>
    </LayoutShell>
  );
}
