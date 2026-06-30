import dynamic from "next/dynamic";

const DynamicWidget = dynamic(() => import("./widget"));

export default function DynamicPreloadPage() {
  return (
    <main>
      <h1>Dynamic preload</h1>
      <DynamicWidget />
    </main>
  );
}
