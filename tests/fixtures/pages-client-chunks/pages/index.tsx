import { BRAND } from "../lib/brand";
import { SharedGallery } from "../lib/shared-gallery";
import { sharedLabel } from "../lib/shared-label";
import { rowLabel } from "../lib/rows/row-label";

export default function Home() {
  return (
    <SharedGallery>
      <h1>
        {BRAND} {sharedLabel("home")} {rowLabel("home", 0)}
      </h1>
    </SharedGallery>
  );
}
