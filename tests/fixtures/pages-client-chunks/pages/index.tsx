import { BRAND } from "../lib/brand";
import { SharedGallery } from "../lib/shared-gallery";
import { sharedLabel } from "../lib/shared-label";

export default function Home() {
  return (
    <SharedGallery>
      <h1>
        {BRAND} {sharedLabel("home")}
      </h1>
    </SharedGallery>
  );
}
