import { galleryItem } from "../components/gallery";
import styles from "../styles/delta.module.css";

export default function Delta() {
  return (
    <p data-page="delta" data-probe="text" className={`app-text ${galleryItem} ${styles.item}`}>
      Delta
    </p>
  );
}
