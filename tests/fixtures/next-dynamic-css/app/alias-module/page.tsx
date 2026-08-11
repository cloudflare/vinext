import styles from "fixture-module-alias";
import "./global.css";

export default function AliasModulePage() {
  return (
    <p id="alias-module" className={`${styles.class} alias-module`}>
      Resolved CSS module aliases keep their order
    </p>
  );
}
