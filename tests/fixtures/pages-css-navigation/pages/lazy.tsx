import dynamic from "next/dynamic";
import { useState } from "react";

// Loads the gallery's stylesheet from a dynamic import too, so its server
// links stay and pages that import the gallery still list it.
const GalleryDialog = dynamic(() => import("../components/gallery-dialog"));

export default function Lazy() {
  const [open, setOpen] = useState(false);
  return (
    <div data-page="lazy">
      <p data-probe="text" className="app-text">
        Lazy
      </p>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <GalleryDialog />}
    </div>
  );
}
