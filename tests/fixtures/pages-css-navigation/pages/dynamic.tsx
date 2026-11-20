import dynamic from "next/dynamic";

const DynamicCard = dynamic(() => import("../components/dynamic-card"));

export default function DynamicPage() {
  return (
    <div data-page="dynamic">
      <DynamicCard />
    </div>
  );
}
