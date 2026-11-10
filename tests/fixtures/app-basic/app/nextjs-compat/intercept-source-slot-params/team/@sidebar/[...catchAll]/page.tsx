import { SidebarCounter } from "./sidebar-counter";

export default async function SidebarPage({ params }: { params: Promise<{ catchAll: string[] }> }) {
  const { catchAll } = await params;
  return (
    <div id="intercept-source-slot-params-sidebar">
      <p id="intercept-source-slot-params-sidebar-path">Sidebar: {catchAll.join("/")}</p>
      <SidebarCounter />
    </div>
  );
}
