import React from "react";
import dynamic from "next/dynamic";

const HeavyComponent = dynamic(() => import("../components/heavy"), {
  loading: () => <p>Loading heavy component...</p>,
});

export default function DynamicPage() {
  return (
    <div>
      <h1>Dynamic Import Page</h1>
      <HeavyComponent label="Loaded dynamically" />
    </div>
  );
}
