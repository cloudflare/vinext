import dynamic from "next/dynamic";
import { useState } from "react";
import { badgeText } from "../components/badge";
import styles from "../styles/epsilon.module.css";

// Loads the note, and with it the badge's stylesheet, only once it opens.
const BadgeNote = dynamic(() => import("../components/badge-note"));

export default function Later() {
  const [open, setOpen] = useState(false);
  return (
    <div data-page="later">
      <p data-probe="text" className={`app-text ${badgeText} ${styles.text}`}>
        Later
      </p>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <BadgeNote />}
    </div>
  );
}
