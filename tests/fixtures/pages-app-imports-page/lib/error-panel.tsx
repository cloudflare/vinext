import { HELP_LINKS } from "./help-links";
import styles from "./error-panel.module.css";

export function ErrorPanel() {
  return (
    <section className={styles.panel} data-marker="marker-error-panel">
      Something went wrong. Try {HELP_LINKS[0]!.label}.
    </section>
  );
}
