import dynamic from "next/dynamic";
import { useState } from "react";

// The note's badge, then chip, stylesheets: chip wins.
const ComboNote = dynamic(() => import("../components/combo-note"));

export default function Combo() {
  const [open, setOpen] = useState(false);
  return (
    <div data-page="combo">
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <ComboNote />}
    </div>
  );
}
