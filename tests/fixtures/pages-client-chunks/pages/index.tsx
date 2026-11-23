import { BRAND } from "../lib/brand";
import { SharedGallery } from "../lib/shared-gallery";
import { sharedLabel } from "../lib/shared-label";
import { rowLabel } from "../lib/rows/row-label";

const loadRowSample = () => import("../lib/rows/format/row-sample");

export default function Home() {
  return (
    <SharedGallery>
      <h1 onClick={() => void loadRowSample()}>
        {BRAND} {sharedLabel("home")} {rowLabel("home", 0)}
      </h1>
    </SharedGallery>
  );
}
