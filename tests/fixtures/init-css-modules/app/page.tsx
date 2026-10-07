import styles from "./styles.module.css";
import scssStyles from "./styles.module.scss";

export default function Page() {
  return (
    <>
      <main className={styles.wrap}>CSS Modules parity</main>
      <span className={scssStyles.wrap}>SCSS Modules parity</span>
    </>
  );
}
