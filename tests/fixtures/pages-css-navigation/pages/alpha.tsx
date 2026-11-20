import { panelText } from "../components/panel";
import styles from "../styles/alpha.module.css";

export default function Alpha() {
  return (
    <p data-page="alpha" data-probe="text" className={`app-text ${panelText} ${styles.text}`}>
      Alpha
    </p>
  );
}
