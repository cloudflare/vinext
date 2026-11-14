import { SlotPanelNote } from "../slot/@panel/slot-panel-note";

// Another route rendering the panel's note, so it doesn't share the slot
// route page's stylesheet.
export default function SlotPanelPage() {
  return <SlotPanelNote />;
}
