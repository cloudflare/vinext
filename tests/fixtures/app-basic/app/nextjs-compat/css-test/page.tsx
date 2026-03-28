import styles from "./styles.module.css";

export default function Page() {
  return (
    <div>
      <h1 id="css-page" className={styles.heading}>
        CSS Module Test
      </h1>
      <p id="css-class-name" data-class={styles.heading}>
        Class applied
      </p>
    </div>
  );
}
