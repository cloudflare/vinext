// Same Server-Component call site as ../rsc-imports-client/page.tsx, plus a
// `loading` component. In the App Router only a dynamic() with `loading` (or
// `ssr: false`) gets its own Suspense boundary, so this page covers the
// dynamic stylesheet next to a boundary.
import dynamic from "next/dynamic";

const ClientWidgetFromServer = dynamic(() => import("../rsc-imports-client/client-widget"), {
  loading: () => <p id="rsc-imports-client-loading">Loading widget...</p>,
});

export default function RscImportsClientLoadingPage() {
  return (
    <div id="rsc-imports-client-content">
      <h1 id="page-title">RSC imports client via next/dynamic with loading</h1>
      <ClientWidgetFromServer />
    </div>
  );
}
