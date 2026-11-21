import { EffectProbe } from "../effect-probe";
import { StatusLink } from "../../link-status/status-link";

export default function GalleryPage() {
  return (
    <>
      <h2>Gallery</h2>
      <EffectProbe name="gallery" />
      <StatusLink
        href="/bfcache-effects/gallery/photo/1"
        id="gallery-open-photo"
        label="Open photo 1"
      />
    </>
  );
}
