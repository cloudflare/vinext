import { galleryItem } from "./gallery";

export default function GalleryDialog() {
  return (
    <p data-probe="dialog" className={`app-text ${galleryItem}`}>
      Gallery dialog
    </p>
  );
}
