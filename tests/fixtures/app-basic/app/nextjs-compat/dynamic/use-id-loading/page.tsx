"use client";

// Same as ../use-id/page.tsx, plus a `loading` component, so the component sits
// inside dynamic()'s own Suspense boundary. Its useId() values must still match
// between the server render and hydration.
import dynamic from "next/dynamic";

const UseIdField = dynamic(() => import("../use-id/use-id-field"), {
  loading: () => <p id="use-id-loading">Loading...</p>,
});

export default function DynamicUseIdLoadingPage() {
  return (
    <div>
      Index
      <UseIdField />
    </div>
  );
}
