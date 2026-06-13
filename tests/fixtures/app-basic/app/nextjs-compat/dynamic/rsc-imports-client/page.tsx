// No "use client" — this page is a pure React Server Component, and it is the
// next/dynamic() CALL SITE. This is the common real-world pattern of a Server
// Component lazy-loading a heavy client widget.
//
// Regression coverage for the CSP-nonce edge case: Next.js renders the dynamic
// preload links via a 'use client' <PreloadChunks> component, which forces it
// into the SSR pass where the request nonce is available — so the preload links
// carry the nonce REGARDLESS of whether the dynamic() call site is a Server or
// Client Component. vinext matches this: DynamicPreloadChunks is also a
// 'use client' component, so even for this Server-Component call site it renders
// in the SSR pass (where withScriptNonce provides the nonce) rather than the
// RSC environment (where the script-nonce React context is unavailable).
//
// The sibling /nextjs-compat/dynamic page only exercises dynamic() called from
// "use client" modules (which render in the SSR pass and therefore see the
// nonce), so this Server-Component call site is otherwise untested.
import dynamic from "next/dynamic";

const ClientWidgetFromServer = dynamic(() => import("./client-widget"));

export default function RscImportsClientPage() {
  return (
    <div id="rsc-imports-client-content">
      <h1 id="page-title">RSC imports client via next/dynamic</h1>
      <ClientWidgetFromServer />
    </div>
  );
}
