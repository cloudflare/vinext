import dynamic from "next/dynamic";
import { badgeText } from "../components/badge";
import styles from "../styles/epsilon.module.css";

// `/note` loads the note without the badge, so the note's chunk gets a copy of
// the badge, whose stylesheet must still come before the page's own.
const BadgeNote = dynamic(() => import("../components/badge-note"));

export default function Epsilon() {
  return (
    <div data-page="epsilon">
      <p data-probe="text" className={`app-text ${badgeText} ${styles.text}`}>
        Epsilon
      </p>
      <BadgeNote />
    </div>
  );
}
