import { panelText } from "../components/panel";
import styles from "../styles/beta.module.css";

export default function Beta() {
  return (
    <p data-page="beta" data-probe="text" className={`app-text ${panelText} ${styles.text}`}>
      Beta
    </p>
  );
}
