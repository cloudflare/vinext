import { SharedGallery } from "../lib/shared-gallery";
import { SharedPanel } from "../lib/shared-panel";
import { sharedLabel } from "../lib/shared-label";
import { kitBadge } from "../lib/kit";

export default function Page() {
  return (
    <SharedGallery>
      <SharedPanel>{kitBadge(sharedLabel("alpha"))}</SharedPanel>
    </SharedGallery>
  );
}
