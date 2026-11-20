import dynamic from "next/dynamic";
import { useState } from "react";
import styles from "../styles/host.module.css";

// The note's badge stylesheet loads after the page's own, so it wins.
const BadgeNote = dynamic(() => import("../components/badge-note"));

export default function Host() {
  const [open, setOpen] = useState(false);
  return (
    <div data-page="host">
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <BadgeNote className={styles.note} />}
    </div>
  );
}
