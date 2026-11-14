import { notFound } from "next/navigation";
import { SlotPanelNote } from "./slot-panel-note";

// The slot's own not-found.tsx replaces it, while the route's page renders.
export default function PanelPage() {
  notFound();
  return <SlotPanelNote />;
}
