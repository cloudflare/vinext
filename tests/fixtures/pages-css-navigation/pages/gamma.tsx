import { galleryItem } from "../components/gallery";
import styles from "../styles/gamma.module.css";

export default function Gamma() {
  return (
    <p data-page="gamma" data-probe="text" className={`app-text ${galleryItem} ${styles.item}`}>
      Gamma
    </p>
  );
}
