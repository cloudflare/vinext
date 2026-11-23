import { SharedGallery } from "../lib/shared-gallery";
import { SharedPanel } from "../lib/shared-panel";
import { SharedTable } from "../lib/shared-table";
import { sharedLabel } from "../lib/shared-label";
import { kitBadge } from "../lib/kit";
import { ALPHA_ROWS } from "../lib/rows";

export default function Page() {
  return (
    <SharedGallery>
      <SharedPanel>{kitBadge(sharedLabel("alpha"))}</SharedPanel>
      <SharedTable />
      <ul>{ALPHA_ROWS.length}</ul>
    </SharedGallery>
  );
}
